/**
 * Discord video stream module.
 * Uses a selfbot (user account) to "Go Live" the Game Boy emulator
 * to a stage/voice channel. Discord blocks video from bot accounts.
 *
 * Flow: emulator raw RGBA frames → our FFmpeg (raw→MPEGTS) → prepareStream (demux) → playStream (Discord UDP)
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Client } from "discord.js-selfbot-v13";
import { Streamer, prepareStream, playStream, Utils } from "@dank074/discord-video-stream";
import { config } from "./config.js";
import { frameStream, GB_WIDTH, GB_HEIGHT, GB_FPS } from "./emulator.js";

let streamer: Streamer | null = null;
let streamClient: Client | null = null;
let isStreaming = false;
let ffmpegProcess: ChildProcessWithoutNullStreams | null = null;

const SCALED_W = GB_WIDTH * 3;  // 480
const SCALED_H = GB_HEIGHT * 3; // 432

export function isStreamActive(): boolean {
  return isStreaming;
}

/**
 * Initialize the selfbot streamer client, join the voice/stage channel,
 * and start piping emulator frames as a Go Live stream.
 */
export async function startStream(): Promise<void> {
  const { streamToken, guildId, stageChannelId } = config.gameboy;

  if (!streamToken || !guildId || !stageChannelId) {
    console.log("[Stream] Missing STREAM_USER_TOKEN, GUILD_ID, or STAGE_CHANNEL_ID — streaming disabled");
    return;
  }

  streamClient = new Client();
  streamer = new Streamer(streamClient);

  await streamClient.login(streamToken);
  console.log(`[Stream] Logged in as ${streamClient.user?.tag}`);

  // Join voice / stage channel
  await streamer.joinVoice(guildId, stageChannelId);
  console.log(`[Stream] Joined channel ${stageChannelId}`);

  // Spawn our own FFmpeg to convert raw RGBA frames → MPEGTS (H.264)
  // This gives us a proper container format that the library can demux.
  ffmpegProcess = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    // Input: raw RGBA frames on stdin
    "-f", "rawvideo",
    "-pixel_format", "rgba",
    "-video_size", `${GB_WIDTH}x${GB_HEIGHT}`,
    "-framerate", String(GB_FPS),
    "-i", "pipe:0",
    // Scale up with nearest-neighbor for crisp pixel art
    "-vf", `scale=${SCALED_W}:${SCALED_H}:flags=neighbor`,
    // Encode as H.264 with minimal latency
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-tune", "zerolatency",
    "-g", String(GB_FPS), // keyframe every 1 second
    "-bf", "0",           // no B-frames (required by Discord)
    "-b:v", "3000k",
    "-maxrate", "5000k",
    "-bufsize", "6000k",
    "-pix_fmt", "yuv420p",
    // Output as MPEGTS to stdout
    "-f", "mpegts",
    "pipe:1",
  ]);

  ffmpegProcess.stderr.on("data", (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) console.error("[Stream FFmpeg]", msg);
  });

  ffmpegProcess.on("close", (code) => {
    console.log(`[Stream] FFmpeg exited with code ${code}`);
  });

  // Pipe emulator raw frames → our FFmpeg stdin
  frameStream.pipe(ffmpegProcess.stdin);

  // Now feed FFmpeg's MPEGTS output to the library's prepareStream
  // with noTranscoding since we already encoded to H.264
  const { command, output } = prepareStream(ffmpegProcess.stdout, {
    noTranscoding: true,
    width: SCALED_W,
    height: SCALED_H,
    frameRate: GB_FPS,
    videoCodec: Utils.normalizeVideoCodec("H264"),
    includeAudio: false,
    minimizeLatency: true,
    bitrateVideo: 3000,
    bitrateVideoMax: 5000,
    bitrateAudio: 0,
    hardwareAcceleratedDecoding: false,
    h26xPreset: "ultrafast",
    customHeaders: {},
    customFfmpegFlags: [],
  });

  command.on("error", (err: Error) => {
    console.error("[Stream] prepareStream error:", err.message);
  });

  // Start sending to Discord
  isStreaming = true;
  playStream(output, streamer, { type: "go-live" })
    .then(() => {
      console.log("[Stream] Stream ended");
      isStreaming = false;
    })
    .catch((err) => {
      console.error("[Stream] playStream error:", err);
      isStreaming = false;
    });

  console.log("[Stream] Go Live started");
}

/** Stop the stream and disconnect */
export function stopStream(): void {
  if (ffmpegProcess) {
    ffmpegProcess.kill("SIGTERM");
    ffmpegProcess = null;
  }
  if (streamer) {
    streamer.stopStream();
    streamer.leaveVoice();
  }
  if (streamClient) {
    streamClient.destroy();
  }
  isStreaming = false;
  console.log("[Stream] Stopped");
}
