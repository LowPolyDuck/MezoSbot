/**
 * Headless Game Boy emulator — DEMOCRACY mode.
 *
 * Clean and fast:
 * - Single 60fps timer: emulation + round resolution + frame output.
 * - Pre-allocated frame buffer — zero GC in the hot loop.
 * - Frames are published through a latest-frame API for stream transports.
 * - Persistent save states: SRAM auto-saved every 30s and on shutdown.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { supabase } from "./db.js";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Gameboy = require("serverboy");

/* ── Constants ─────────────────────────────────────────────────────── */

export const GB_WIDTH = 160;
export const GB_HEIGHT = 144;
export const STREAM_FPS = 60;

const BASE_SPEED = parseInt(process.env.GB_SPEED ?? "3", 10);
const TICK_MS = 1000 / STREAM_FPS;
const FRAMES_PER_TICK = BASE_SPEED;
const HOLD_FRAMES = parseInt(process.env.GB_HOLD_FRAMES ?? "16", 10);
const FRAME_BYTES = GB_WIDTH * GB_HEIGHT * 4;
const SAVE_INTERVAL_MS = 300000; // Auto-save every 5 minutes
const SAVES_DIR = path.join(process.cwd(), "saves");

export interface FrameMeta {
  width: number;
  height: number;
  bytes: number;
  seq: number;
  capturedAtMs: number;
}

export const BUTTONS = ["A", "B", "UP", "DOWN", "LEFT", "RIGHT", "START", "SELECT"] as const;
export type GBButton = (typeof BUTTONS)[number];

const BUTTON_EMOJI: Record<GBButton, string> = {
  A: "🅰️", B: "🅱️", UP: "⬆️", DOWN: "⬇️",
  LEFT: "⬅️", RIGHT: "➡️", START: "▶️", SELECT: "⏸️",
};

export function getButtonEmoji(button: GBButton): string {
  return BUTTON_EMOJI[button];
}

/* ── Bid pool ──────────────────────────────────────────────────────── */

export interface Bid { userId: string; button: GBButton; amount: number; seq: number; }
export interface ButtonVote { button: GBButton; totalSats: number; voters: Bid[]; firstSeq: number; }
export interface RoundResult {
  winningButton: GBButton;
  winners: Bid[];
  winningSats: number;
  tally: ButtonVote[];
  totalBids: number;
}

const bidPool = new Map<string, Bid>();
let bidSeq = 0;

export function submitBid(userId: string, button: GBButton, amount: number): { ok: boolean; reason?: string } {
  if (!running) return { ok: false, reason: "Emulator is not running." };
  if (amount < config.gameboy.minBid) return { ok: false, reason: `Minimum bid is ${config.gameboy.minBid} sats.` };
  bidPool.set(userId, { userId, button, amount, seq: bidSeq++ });
  return { ok: true };
}

export function getCurrentBidCount(): number { return bidPool.size; }

/* ── State ─────────────────────────────────────────────────────────── */

let gb: any = null;
let running = false;
let loopHandle: ReturnType<typeof setInterval> | null = null;
let saveHandle: ReturnType<typeof setInterval> | null = null;
let currentRomPath: string | null = null;
let activeButton: GBButton | null = null;
let activeHoldRemaining = 0;
let onRoundResolved: ((result: RoundResult) => void) | null = null;

// Pre-allocated frame ring buffers — avoid allocations in the hot loop.
const frameRing = [Buffer.alloc(FRAME_BYTES), Buffer.alloc(FRAME_BYTES)];
let frameRingIdx = 0;
let latestFrame: Buffer | null = null;
let latestMeta: FrameMeta | null = null;
let frameSeq = 0;
const frameSubscribers = new Set<(meta: FrameMeta) => void>();

// Round timing tracked inline
let roundMs = 500;
let msSinceLastRound = 0;

/* ── Public API ────────────────────────────────────────────────────── */

export function isRunning(): boolean { return running; }

export function onRound(cb: (result: RoundResult) => void): void {
  onRoundResolved = cb;
}

/**
 * Subscribe to frame-ready notifications.
 * Consumers should call `getLatestFrameCopy` if they need owned memory.
 */
export function subscribeFrames(cb: (meta: FrameMeta) => void): () => void {
  frameSubscribers.add(cb);
  return () => {
    frameSubscribers.delete(cb);
  };
}

/**
 * Returns a reference to the latest frame buffer.
 * The reference is valid until the next frame publication.
 */
export function getLatestFrameRef(): { frame: Buffer; meta: FrameMeta } | null {
  if (!latestFrame || !latestMeta) return null;
  return { frame: latestFrame, meta: latestMeta };
}

/**
 * Copies the latest frame into caller-provided memory.
 * This is the safe option for async consumers.
 */
export function getLatestFrameCopy(target?: Buffer): { frame: Buffer; meta: FrameMeta } | null {
  if (!latestFrame || !latestMeta) return null;
  const out = target && target.length >= FRAME_BYTES ? target : Buffer.allocUnsafe(FRAME_BYTES);
  latestFrame.copy(out, 0, 0, FRAME_BYTES);
  return { frame: out, meta: latestMeta };
}

/* ── Save state management ─────────────────────────────────────────── */

function getRomName(romPath: string): string {
  return path.basename(romPath, path.extname(romPath));
}

function getSaveFilePath(romPath: string): string {
  return path.join(SAVES_DIR, `${getRomName(romPath)}.sav`);
}

async function loadSaveState(romPath: string): Promise<any[] | null> {
  const romName = getRomName(romPath);

  // Try Supabase first
  try {
    const { data, error } = await supabase
      .from("game_saves")
      .select("save_data")
      .eq("rom_name", romName)
      .single();

    if (!error && data?.save_data) {
      const saveData = JSON.parse(data.save_data);
      console.log(`[Emulator] Loaded save state from Supabase for "${romName}"`);
      return saveData;
    }
  } catch (err) {
    console.warn(`[Emulator] Supabase load failed, trying local fallback:`, (err as Error)?.message ?? err);
  }

  // Fall back to local file
  const savePath = getSaveFilePath(romPath);
  try {
    if (fs.existsSync(savePath)) {
      const saveData = JSON.parse(fs.readFileSync(savePath, "utf-8"));
      console.log(`[Emulator] Loaded save state from local file ${savePath}`);
      return saveData;
    }
  } catch (err) {
    console.warn(`[Emulator] Failed to load local save state:`, (err as Error)?.message ?? err);
  }

  return null;
}

function saveSaveState(awaitSupabase?: boolean): Promise<void> | void {
  if (!gb || !running || !currentRomPath) return;

  try {
    const saveData = gb.getSaveData();
    if (!saveData || saveData.length === 0) return;

    const json = JSON.stringify(saveData);
    const romName = getRomName(currentRomPath);

    // Local write (synchronous, fast)
    if (!fs.existsSync(SAVES_DIR)) {
      fs.mkdirSync(SAVES_DIR, { recursive: true });
    }
    const savePath = getSaveFilePath(currentRomPath);
    fs.writeFileSync(savePath, json, "utf-8");
    console.log(`[Emulator] Saved game state locally to ${savePath}`);

    // Supabase upsert
    const upsertPromise = (async () => {
      const { error } = await supabase
        .from("game_saves")
        .upsert({ rom_name: romName, save_data: json, updated_at: new Date().toISOString() });
      if (error) {
        console.error(`[Emulator] Supabase save failed:`, error.message);
      } else {
        console.log(`[Emulator] Saved game state to Supabase for "${romName}"`);
        // Remove local file now that Supabase has the authoritative copy
        try { fs.unlinkSync(savePath); } catch { /* already gone */ }
      }
    })();

    if (awaitSupabase) return upsertPromise;
    // Fire-and-forget during normal operation
    upsertPromise.catch(() => {});
  } catch (err) {
    console.error(`[Emulator] Failed to save state:`, (err as Error)?.message ?? err);
  }
}

export async function startEmulator(romPath: string): Promise<void> {
  if (running) return;

  currentRomPath = romPath;
  const romData = fs.readFileSync(romPath);
  const saveData = await loadSaveState(romPath);

  gb = new Gameboy();
  gb.loadRom(romData, saveData);
  running = true;
  roundMs = config.gameboy.roundMs;
  msSinceLastRound = 0;

  // Start emulation loop
  loopHandle = setInterval(tick, TICK_MS);

  // Start auto-save loop
  saveHandle = setInterval(saveSaveState, SAVE_INTERVAL_MS);

  console.log(`[Emulator] Started | ${BASE_SPEED}× | ${FRAMES_PER_TICK}f/tick @ ${STREAM_FPS}fps | hold=${HOLD_FRAMES}f | ${roundMs}ms rounds`);
  if (saveData) {
    console.log(`[Emulator] Continuing from saved game state`);
  }
}

export async function stopEmulator(): Promise<void> {
  if (!running) return;

  // Save state before shutdown — await Supabase so it completes before exit
  await saveSaveState(true);

  running = false;
  if (loopHandle) clearInterval(loopHandle);
  if (saveHandle) clearInterval(saveHandle);
  loopHandle = null;
  saveHandle = null;
  bidPool.clear();
  latestFrame = null;
  latestMeta = null;
  currentRomPath = null;
  console.log(`[Emulator] Stopped and saved game state`);
}

/* ── Single tick — emulation + rounds + frame output ───────────────── */

function tick(): void {
  if (!gb || !running) return;

  // Round resolution
  msSinceLastRound += TICK_MS;
  if (msSinceLastRound >= roundMs && bidPool.size > 0) {
    msSinceLastRound = 0;
    resolveRound();
  }

  // Run game frames
  let screen: any = null;
  for (let f = 0; f < FRAMES_PER_TICK; f++) {
    if (activeButton && activeHoldRemaining > 0) {
      gb.pressKeys([Gameboy.KEYMAP[activeButton]]);
      if (--activeHoldRemaining <= 0) activeButton = null;
    }
    screen = gb.doFrame();
  }

  // Publish latest frame. Slow consumers can drop old frames safely.
  if (screen && screen.length >= FRAME_BYTES) {
    frameRingIdx = frameRingIdx ^ 1;
    const slot = frameRing[frameRingIdx];
    copyFrameIntoSlot(screen, slot);
    frameSeq += 1;
    latestFrame = slot;
    latestMeta = {
      width: GB_WIDTH,
      height: GB_HEIGHT,
      bytes: FRAME_BYTES,
      seq: frameSeq,
      capturedAtMs: Date.now(),
    };
    for (const cb of frameSubscribers) {
      cb(latestMeta);
    }
  }
}

function copyFrameIntoSlot(screen: any, slot: Buffer): void {
  if (typeof screen.subarray === "function") {
    slot.set(screen.subarray(0, FRAME_BYTES), 0);
    return;
  }
  for (let i = 0; i < FRAME_BYTES; i++) {
    slot[i] = screen[i] & 0xff;
  }
}

/* ── Round resolution ──────────────────────────────────────────────── */

function resolveRound(): void {
  const byButton = new Map<GBButton, ButtonVote>();
  for (const bid of bidPool.values()) {
    let v = byButton.get(bid.button);
    if (!v) { v = { button: bid.button, totalSats: 0, voters: [], firstSeq: bid.seq }; byButton.set(bid.button, v); }
    v.totalSats += bid.amount;
    v.voters.push(bid);
    if (bid.seq < v.firstSeq) v.firstSeq = bid.seq;
  }
  const totalBids = bidPool.size;
  bidPool.clear();

  const tally = [...byButton.values()].sort((a, b) => b.totalSats !== a.totalSats ? b.totalSats - a.totalSats : a.firstSeq - b.firstSeq);
  const winner = tally[0];
  if (!winner) return;

  activeButton = winner.button;
  activeHoldRemaining = HOLD_FRAMES;
  onRoundResolved?.({ winningButton: winner.button, winners: winner.voters, winningSats: winner.totalSats, tally, totalBids });
}
