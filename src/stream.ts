/**
 * Browser stream transport: Canvas + WebSocket
 * Fast, low-latency streaming using raw frame data and HTML5 Canvas.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
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
  ws: WebSocket;
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
let wss: WebSocketServer | null = null;
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
  const wsUrl = `ws://${process.env.RENDER ? '${window.location.host}' : '0.0.0.0:' + config.streaming.port}`;

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
    canvas { width: ${ws}px; height: ${hs}px; image-rendering: pixelated; border-radius: 12px; border: 1px solid #1d2330; background: black; display: block; }
    .status { font-size: 14px; color: #6b7280; margin-top: 12px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>MezoSbot Browser Stream</h1>
    <p>Low-latency canvas streaming.</p>
    <canvas id="canvas" width="${GB_WIDTH}" height="${GB_HEIGHT}"></canvas>
    <div class="status" id="status">Connecting...</div>
  </div>
  <script>
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d', { alpha: false });
    const status = document.getElementById('status');

    // Disable image smoothing for pixel-perfect rendering
    ctx.imageSmoothingEnabled = false;

    let ws;
    let reconnectTimer;

    function connect() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(protocol + '//' + window.location.host + '/stream');

      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        status.textContent = 'Connected';
        status.style.color = '#10b981';
      };

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          const rgba = new Uint8ClampedArray(event.data);
          const imageData = new ImageData(rgba, ${GB_WIDTH}, ${GB_HEIGHT});
          ctx.putImageData(imageData, 0, 0);
        }
      };

      ws.onerror = () => {
        status.textContent = 'Connection error';
        status.style.color = '#ef4444';
      };

      ws.onclose = () => {
        status.textContent = 'Disconnected - reconnecting...';
        status.style.color = '#f59e0b';

        // Reconnect after 2 seconds
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 2000);
      };
    }

    connect();
  </script>
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
    client.ws.close();
  } catch {
    // no-op
  }
  streamClients.delete(id);
  stats.activeClients = streamClients.size;
  console.log(`[Stream] Client ${id} disconnected (${streamClients.size} active)`);
}

function pushFrameToClients(rgba: Buffer): void {
  if (streamClients.size === 0) return;

  const encodeStart = Date.now();

  // Send raw RGBA data to all connected clients
  for (const client of streamClients.values()) {
    try {
      if (client.ws.readyState !== WebSocket.OPEN) {
        removeClient(client.id);
        continue;
      }

      client.ws.send(rgba, { binary: true });
    } catch (err) {
      console.error(`[Stream] Failed to send frame to client ${client.id}:`, (err as Error)?.message ?? err);
      removeClient(client.id);
    }
  }

  stats.encodedFrames += 1;
  const elapsed = Date.now() - encodeStart;
  stats.avgEncodeMs = stats.avgEncodeMs === 0 ? elapsed : stats.avgEncodeMs * 0.9 + elapsed * 0.1;
  stats.lastSentFrameAtMs = Date.now();
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
    pushFrameToClients(sourceFrameCopy);
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

    // WebSocket server
    wss = new WebSocketServer({ server: httpServer, path: "/stream" });

    wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
      const clientId = `ws-${Date.now()}-${Math.random().toString(36).substring(7)}`;

      streamClients.set(clientId, {
        id: clientId,
        ws,
        connectedAtMs: Date.now(),
      });
      stats.activeClients = streamClients.size;

      console.log(`[Stream] WebSocket client ${clientId} connected (${streamClients.size} active)`);

      ws.on("close", () => {
        removeClient(clientId);
      });

      ws.on("error", () => {
        removeClient(clientId);
      });
    });

    httpServer.listen(config.streaming.port, "0.0.0.0", () => {
      resolve();
    });
  });

  console.log(`[Stream] Canvas+WebSocket viewer ready at ${streamBaseUrl()}/`);
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
  if (wss) {
    wss.close();
    wss = null;
  }
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
}
