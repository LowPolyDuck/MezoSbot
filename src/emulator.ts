/**
 * Headless Game Boy emulator — DEMOCRACY mode.
 *
 * Clean and fast:
 * - Single 60fps timer: emulation + round resolution + frame output.
 * - Pre-allocated frame buffer — zero GC in the hot loop.
 * - Frames go straight to ffplay for local display. No encoding overhead.
 */
import fs from "node:fs";
import { PassThrough } from "node:stream";
import { config } from "./config.js";

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
let activeButton: GBButton | null = null;
let activeHoldRemaining = 0;
let onRoundResolved: ((result: RoundResult) => void) | null = null;

// Pre-allocated — never alloc in the hot loop
const frameBuf = Buffer.alloc(FRAME_BYTES);

// Frames go straight to ffplay stdin via this pipe
export const frameStream = new PassThrough({ highWaterMark: FRAME_BYTES * 4 });

// Round timing tracked inline
let roundMs = 500;
let msSinceLastRound = 0;

/* ── Public API ────────────────────────────────────────────────────── */

export function isRunning(): boolean { return running; }

export function onRound(cb: (result: RoundResult) => void): void {
  onRoundResolved = cb;
}

export function startEmulator(romPath: string): void {
  if (running) return;
  gb = new Gameboy();
  gb.loadRom(fs.readFileSync(romPath));
  running = true;
  roundMs = config.gameboy.roundMs;
  msSinceLastRound = 0;
  loopHandle = setInterval(tick, TICK_MS);
  console.log(`[Emulator] Started | ${BASE_SPEED}× | ${FRAMES_PER_TICK}f/tick @ ${STREAM_FPS}fps | hold=${HOLD_FRAMES}f | ${roundMs}ms rounds`);
}

export function stopEmulator(): void {
  if (!running) return;
  running = false;
  if (loopHandle) clearInterval(loopHandle);
  loopHandle = null;
  bidPool.clear();
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

  // Write frame — ffplay reads raw RGBA, no encoding needed
  if (screen && screen.length >= FRAME_BYTES) {
    for (let i = 0; i < FRAME_BYTES; i++) frameBuf[i] = screen[i] & 0xff;
    frameStream.write(frameBuf);
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
