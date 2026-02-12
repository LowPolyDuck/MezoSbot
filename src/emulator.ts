/**
 * Headless Game Boy emulator — auction-based input system.
 *
 * HOW IT WORKS:
 * 1. Users submit bids: { button, amount } via text or slash commands.
 *    Each user can have ONE active bid per round. Re-bidding replaces it.
 * 2. Every GB_ROUND_MS (default 500ms), the round resolves:
 *    - Highest bid wins → their input is applied to the Game Boy.
 *    - Winner is charged their bid. Everyone else keeps their sats.
 *    - Ties broken by who bid first.
 * 3. Between rounds, the game runs at GB_SPEED × real-time.
 *    The game is ALWAYS moving — steady speed, no jerkiness.
 * 4. No per-user cooldown needed — the round itself is the natural cooldown.
 *    You can only bid once per round anyway.
 */
import fs from "node:fs";
import { PassThrough } from "node:stream";
import { config } from "./config.js";

// serverboy is a CommonJS module with no types
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Gameboy = require("serverboy");

/* ── Constants ─────────────────────────────────────────────────────── */

export const GB_WIDTH = 160;
export const GB_HEIGHT = 144;
export const GB_FPS = 60;

const BASE_SPEED = parseInt(process.env.GB_SPEED ?? "3", 10);
const TICK_MS = 1000 / GB_FPS;

/**
 * Game-frames to hold the winning button.
 * Pokemon needs ~16 frames for one walking step.
 * Default 16 ensures a directional press always produces movement.
 */
const HOLD_FRAMES = parseInt(process.env.GB_HOLD_FRAMES ?? "16", 10);

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

export interface Bid {
  userId: string;
  button: GBButton;
  amount: number;
  /** Monotonic counter for tie-breaking (lower = earlier) */
  seq: number;
}

export interface RoundResult {
  winner: Bid;
  totalBids: number;
}

/** Current round's bid pool — one bid per user, keyed by userId */
const bidPool = new Map<string, Bid>();
let bidSeq = 0;

/**
 * Submit a bid for the current round.
 * If the user already bid this round, their bid is REPLACED (lets them outbid others).
 */
export function submitBid(userId: string, button: GBButton, amount: number): { ok: boolean; reason?: string } {
  if (!running) return { ok: false, reason: "Emulator is not running." };

  const minBid = config.gameboy.minBid;
  if (amount < minBid) {
    return { ok: false, reason: `Minimum bid is ${minBid} sats.` };
  }

  bidPool.set(userId, { userId, button, amount, seq: bidSeq++ });
  return { ok: true };
}

/** How many bids are in the current round */
export function getCurrentBidCount(): number {
  return bidPool.size;
}

/* ── State ─────────────────────────────────────────────────────────── */

let gb: any = null;
let running = false;
let frameLoopHandle: ReturnType<typeof setInterval> | null = null;
let roundHandle: ReturnType<typeof setInterval> | null = null;

let activeButton: GBButton | null = null;
let activeHoldRemaining = 0;

/** Fired when a round resolves with a winner */
let onRoundResolved: ((result: RoundResult) => void) | null = null;

/** Raw RGBA frame stream for the video streamer */
export const frameStream = new PassThrough({ highWaterMark: GB_WIDTH * GB_HEIGHT * 4 * 4 });

/* ── Public API ────────────────────────────────────────────────────── */

export function isRunning(): boolean {
  return running;
}

/**
 * Register a callback for when a round resolves.
 * The callback receives the winning bid and total bid count.
 * Used to post the result in Discord and charge the winner.
 */
export function onRound(cb: (result: RoundResult) => void): void {
  onRoundResolved = cb;
}

/** Load a ROM and start emulation + round timer */
export function startEmulator(romPath: string): void {
  if (running) return;

  const romBuffer = fs.readFileSync(romPath);
  gb = new Gameboy();
  gb.loadRom(romBuffer);
  running = true;

  // Frame loop — renders at 60fps, runs game at BASE_SPEED×
  frameLoopHandle = setInterval(tick, TICK_MS);

  // Round timer — resolve the auction at fixed intervals
  const roundMs = config.gameboy.roundMs;
  roundHandle = setInterval(resolveRound, roundMs);

  console.log(
    `[Emulator] Started — ROM: ${romPath} | ` +
    `${BASE_SPEED}× speed | hold=${HOLD_FRAMES}f | ` +
    `${roundMs}ms rounds | min bid ${config.gameboy.minBid} sats`
  );
}

/** Stop everything */
export function stopEmulator(): void {
  if (!running) return;
  running = false;
  if (frameLoopHandle) clearInterval(frameLoopHandle);
  if (roundHandle) clearInterval(roundHandle);
  frameLoopHandle = null;
  roundHandle = null;
  bidPool.clear();
  console.log("[Emulator] Stopped");
}

/* ── Round resolution ──────────────────────────────────────────────── */

function resolveRound(): void {
  if (!running || bidPool.size === 0) return;

  // Find the highest bid (ties broken by earliest seq)
  let best: Bid | null = null;
  for (const bid of bidPool.values()) {
    if (
      !best ||
      bid.amount > best.amount ||
      (bid.amount === best.amount && bid.seq < best.seq)
    ) {
      best = bid;
    }
  }

  const totalBids = bidPool.size;
  bidPool.clear();

  if (!best) return;

  // Apply the winning input
  activeButton = best.button;
  activeHoldRemaining = HOLD_FRAMES;

  // Notify (charge winner + post to Discord)
  onRoundResolved?.({ winner: best, totalBids });
}

/* ── Frame loop ────────────────────────────────────────────────────── */

function tick(): void {
  if (!gb || !running) return;

  // Steady speed — no turbo. Consistent game feel.
  const framesToRun = BASE_SPEED;
  let lastScreen: any = null;

  for (let f = 0; f < framesToRun; f++) {
    // Apply held button
    if (activeButton && activeHoldRemaining > 0) {
      gb.pressKeys([Gameboy.KEYMAP[activeButton]]);
      activeHoldRemaining--;
      if (activeHoldRemaining <= 0) {
        activeButton = null;
      }
    }

    // Advance one game frame
    lastScreen = gb.doFrame();
  }

  // Write only the final frame to the video stream (60fps output)
  if (lastScreen && lastScreen.length > 0) {
    const buf = Buffer.alloc(GB_WIDTH * GB_HEIGHT * 4);
    for (let i = 0; i < buf.length; i++) {
      buf[i] = lastScreen[i] & 0xff;
    }
    if (!frameStream.writableNeedDrain) {
      frameStream.write(buf);
    }
  }
}
