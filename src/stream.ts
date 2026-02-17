/**
 * Browser stream transport: MJPEG over HTTP
 * Simple, reliable motion JPEG streaming that works everywhere.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import sharp from "sharp";
import {
  getLatestFrameCopy,
  subscribeFrames,
  GB_WIDTH,
  GB_HEIGHT,
  type FrameMeta,
} from "./emulator.js";
import { config } from "./config.js";

interface StreamClient {
  id: string;
  res: ServerResponse;
  connectedAtMs: number;
}

interface StreamStats {
  producedFrames: number;
  encodedFrames: number;
  droppedFrames: number;
  currentEncodeFps: number;
  avgEncodeMs: number;
  lastSourceFrameAtMs: number;
  lastSentFrameAtMs: number;
  lastProducedSeq: number;
  activeClients: number;
}

const streamClients = new Map<string, StreamClient>();
let httpServer: Server | null = null;
let encodeLoop: ReturnType<typeof setTimeout> | null = null;
let unsubscribeFrames: (() => void) | null = null;
let latestObservedFrame: FrameMeta | null = null;
let sourceFrameCopy = Buffer.alloc(GB_WIDTH * GB_HEIGHT * 4);
const requestedFps = Math.max(1, Math.min(config.streaming.maxFps, config.streaming.targetFps));
const minFps = Math.max(1, Math.min(requestedFps, config.streaming.minFps));
let currentEncodeFps = requestedFps;
let tuneProducedStart = 0;
let tuneDroppedStart = 0;
let tuneWindowStartMs = Date.now();

const stats: StreamStats = {
  producedFrames: 0,
  encodedFrames: 0,
  droppedFrames: 0,
  currentEncodeFps,
  avgEncodeMs: 0,
  lastSourceFrameAtMs: 0,
  lastSentFrameAtMs: 0,
  lastProducedSeq: 0,
  activeClients: 0,
};

function streamBaseUrl(): string {
  return `http://0.0.0.0:${config.streaming.port}`;
}

function buildViewerHtml(): string {
  const ws = GB_WIDTH * config.streaming.viewerScale;
  const hs = GB_HEIGHT * config.streaming.viewerScale;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>MezoSbot Stream</title>
  <style>
    body { margin: 0; background: #0b0d12; color: #e7edf7; font-family: Inter, Segoe UI, Arial, sans-serif; }
    .wrap { max-width: 960px; margin: 32px auto; padding: 0 16px; }
    h1 { margin: 0 0 8px 0; font-size: 22px; }
    p { margin: 0 0 18px 0; color: #a9b3c7; }
    img { width: ${ws}px; height: ${hs}px; image-rendering: pixelated; border-radius: 12px; border: 1px solid #1d2330; background: black; display: block; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>MezoSbot Browser Stream</h1>
    <p>Low-latency MJPEG viewer.</p>
    <img src="/stream.mjpeg" alt="Game stream" />
  </div>
</body>
</html>`;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function sendHtml(res: ServerResponse, html: string): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

function removeClient(id: string): void {
  const client = streamClients.get(id);
  if (!client) return;
  try {
    if (!client.res.writableEnded) {
      client.res.end();
    }
  } catch {
    // no-op
  }
  streamClients.delete(id);
  stats.activeClients = streamClients.size;
  console.log(`[Stream] Client ${id} disconnected (${streamClients.size} active)`);
}

async function handleMjpegStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const clientId = `mjpeg-${Date.now()}-${Math.random().toString(36).substring(7)}`;

  res.writeHead(200, {
    "Content-Type": "multipart/x-mixed-replace; boundary=frame",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
    "Connection": "close",
  });

  streamClients.set(clientId, {
    id: clientId,
    res,
    connectedAtMs: Date.now(),
  });
  stats.activeClients = streamClients.size;

  console.log(`[Stream] MJPEG client ${clientId} connected (${streamClients.size} active)`);

  req.on("close", () => {
    removeClient(clientId);
  });

  req.on("error", () => {
    removeClient(clientId);
  });
}

async function pushFrameToClients(rgba: Buffer): Promise<void> {
  if (streamClients.size === 0) return;

  const encodeStart = Date.now();

  try {
    // Convert RGBA to JPEG using sharp
    const jpeg = await sharp(rgba, {
      raw: {
        width: GB_WIDTH,
        height: GB_HEIGHT,
        channels: 4,
      },
    })
      .jpeg({ quality: 80 })
      .toBuffer();

    // Send to all connected clients
    for (const client of streamClients.values()) {
      try {
        if (!client.res.writable || client.res.writableEnded) {
          removeClient(client.id);
          continue;
        }

        client.res.write(`--frame\r\n`);
        client.res.write(`Content-Type: image/jpeg\r\n`);
        client.res.write(`Content-Length: ${jpeg.length}\r\n`);
        client.res.write(`\r\n`);
        client.res.write(jpeg);
        client.res.write(`\r\n`);
      } catch (err) {
        console.error(`[Stream] Failed to send frame to client ${client.id}:`, (err as Error)?.message ?? err);
        removeClient(client.id);
      }
    }

    stats.encodedFrames += 1;
    const elapsed = Date.now() - encodeStart;
    stats.avgEncodeMs = stats.avgEncodeMs === 0 ? elapsed : stats.avgEncodeMs * 0.9 + elapsed * 0.1;
    stats.lastSentFrameAtMs = Date.now();
  } catch (err) {
    console.error("[Stream] Frame encoding error:", (err as Error)?.message ?? err);
  }
}

function startEncodeLoop(): void {
  const loop = () => {
    if (!latestObservedFrame) return;
    const frame = getLatestFrameCopy(sourceFrameCopy);
    if (!frame) return;
    if (stats.lastProducedSeq > 0 && frame.meta.seq > stats.lastProducedSeq + 1) {
      stats.droppedFrames += frame.meta.seq - stats.lastProducedSeq - 1;
    }
    stats.lastProducedSeq = frame.meta.seq;
    pushFrameToClients(sourceFrameCopy).catch(() => {});
  };

  const schedule = () => {
    const intervalMs = Math.round(1000 / Math.max(1, currentEncodeFps));
    encodeLoop = setTimeout(() => {
      loop();
      maybeAutoTune();
      schedule();
    }, intervalMs);
  };

  schedule();
}

function maybeAutoTune(): void {
  if (!config.streaming.autoTune) return;
  const now = Date.now();
  if (now - tuneWindowStartMs < 5000) return;

  const producedInWindow = Math.max(1, stats.producedFrames - tuneProducedStart);
  const droppedInWindow = stats.droppedFrames - tuneDroppedStart;
  const dropRatio = droppedInWindow / producedInWindow;

  if (dropRatio > 0.25 && currentEncodeFps > minFps) {
    currentEncodeFps = Math.max(minFps, currentEncodeFps - 5);
  } else if (dropRatio < 0.05 && currentEncodeFps < requestedFps) {
    currentEncodeFps = Math.min(requestedFps, currentEncodeFps + 5);
  }

  stats.currentEncodeFps = currentEncodeFps;
  tuneWindowStartMs = now;
  tuneProducedStart = stats.producedFrames;
  tuneDroppedStart = stats.droppedFrames;
}

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (method === "GET" && url.pathname === "/") {
    sendHtml(res, buildViewerHtml());
    return;
  }

  if (method === "GET" && url.pathname === "/stream.mjpeg") {
    await handleMjpegStream(req, res);
    return;
  }

  if (method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, {
      status: "ok",
      stream: {
        ...stats,
        targetFps: requestedFps,
      },
    });
    return;
  }

  if (method === "GET" && url.pathname === "/metrics") {
    sendJson(res, 200, {
      stream: {
        ...stats,
        targetFps: requestedFps,
      },
    });
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

export async function startStream(): Promise<void> {
  if (httpServer) return;

  unsubscribeFrames = subscribeFrames((meta) => {
    latestObservedFrame = meta;
    stats.producedFrames += 1;
    stats.lastSourceFrameAtMs = meta.capturedAtMs;
  });

  startEncodeLoop();

  await new Promise<void>((resolve) => {
    httpServer = createServer((req, res) => {
      handleHttpRequest(req, res).catch((err) => {
        console.error("[Stream] HTTP handler error:", (err as Error)?.message ?? err);
        sendJson(res, 500, { error: "internal_error" });
      });
    });
    httpServer.listen(config.streaming.port, "0.0.0.0", () => {
      resolve();
    });
  });

  console.log(`[Stream] MJPEG viewer ready at ${streamBaseUrl()}/`);
  console.log(`[Stream] Health endpoint: ${streamBaseUrl()}/healthz`);
  console.log(`[Stream] ${GB_WIDTH}x${GB_HEIGHT} source | encode ${requestedFps}fps (min ${minFps})`);
}

export function stopStream(): void {
  if (encodeLoop) {
    clearTimeout(encodeLoop);
    encodeLoop = null;
  }
  if (unsubscribeFrames) {
    unsubscribeFrames();
    unsubscribeFrames = null;
  }
  for (const id of streamClients.keys()) {
    removeClient(id);
  }
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
}
