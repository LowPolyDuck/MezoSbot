/**
 * Local display — opens the Game Boy emulator in an ffplay window.
 * The user screen-shares this window themselves via Discord.
 *
 * No selfbot. No encoding pipeline. Just raw frames → ffplay → window.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { frameStream, GB_WIDTH, GB_HEIGHT, STREAM_FPS } from "./emulator.js";

let ffplay: ChildProcess | null = null;

const SCALE = 3;
const W = GB_WIDTH * SCALE;
const H = GB_HEIGHT * SCALE;

export async function startStream(): Promise<void> {
  const proc = spawn("ffplay", [
    "-f", "rawvideo",
    "-pixel_format", "rgba",
    "-video_size", `${GB_WIDTH}x${GB_HEIGHT}`,
    "-framerate", String(STREAM_FPS),
    "-i", "pipe:0",
    "-vf", `scale=${W}:${H}:flags=neighbor`,
    "-fflags", "nobuffer",
    "-flags", "low_delay",
    "-framedrop",
    "-window_title", "MezoSbot - Pokemon",
    "-an",
    // Suppress all ffplay status output
    "-loglevel", "error",
  ], {
    stdio: ["pipe", "ignore", "ignore"],
  });

  ffplay = proc;

  if (proc.stdin) {
    frameStream.pipe(proc.stdin);
  }

  proc.on("close", (code) => {
    console.log(`[Display] ffplay exited (code ${code})`);
    ffplay = null;
  });

  console.log(`[Display] Window opened (${W}×${H} @ ${STREAM_FPS}fps) — share this window on Discord`);
}

export function stopStream(): void {
  if (ffplay) {
    ffplay.kill("SIGTERM");
    ffplay = null;
  }
}
