/**
 * Web Canvas display — HTTP server + WebSocket frame streaming.
 *
 * Serves a single HTML page with a <canvas> that receives raw RGBA frames
 * over WebSocket and renders them with nearest-neighbor scaling.
 *
 * Runs on PORT (default 3000). Render exposes this automatically.
 */
import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { frameStream, GB_WIDTH, GB_HEIGHT, STREAM_FPS } from "./emulator.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const WS_FPS = 20; // throttle WebSocket to ~20fps to keep bandwidth sane
const WS_INTERVAL = 1000 / WS_FPS;
const FRAME_BYTES = GB_WIDTH * GB_HEIGHT * 4;

let latestFrame: Buffer | null = null;
let server: http.Server | null = null;
let wss: WebSocketServer | null = null;
let broadcastTimer: ReturnType<typeof setInterval> | null = null;

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MezoSbot — Game Boy</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #111;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    color: #ccc;
  }
  h1 {
    font-size: 1.2rem;
    margin-bottom: 12px;
    color: #8bac0f;
    text-transform: uppercase;
    letter-spacing: 2px;
  }
  canvas {
    image-rendering: pixelated;
    image-rendering: crisp-edges;
    border: 2px solid #333;
    border-radius: 4px;
  }
  #status {
    margin-top: 10px;
    font-size: 0.85rem;
    color: #666;
  }
  .connected { color: #8bac0f !important; }
  .disconnected { color: #e44 !important; }
</style>
</head>
<body>
<h1>MezoSbot</h1>
<canvas id="gb" width="${GB_WIDTH}" height="${GB_HEIGHT}"></canvas>
<div id="status" class="disconnected">Connecting...</div>
<script>
(function() {
  const W = ${GB_WIDTH}, H = ${GB_HEIGHT}, SCALE = 3;
  const canvas = document.getElementById('gb');
  canvas.style.width = (W * SCALE) + 'px';
  canvas.style.height = (H * SCALE) + 'px';
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  const statusEl = document.getElementById('status');

  let ws, frames = 0, lastFps = 0, fpsTimer;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws');
    ws.binaryType = 'arraybuffer';

    ws.onopen = function() {
      statusEl.textContent = 'Connected';
      statusEl.className = 'connected';
      frames = 0;
      fpsTimer = setInterval(function() {
        lastFps = frames;
        frames = 0;
        statusEl.textContent = 'Connected — ' + lastFps + ' fps';
      }, 1000);
    };

    ws.onmessage = function(e) {
      if (!(e.data instanceof ArrayBuffer) || e.data.byteLength < W * H * 4) return;
      img.data.set(new Uint8ClampedArray(e.data));
      ctx.putImageData(img, 0, 0);
      frames++;
    };

    ws.onclose = function() {
      statusEl.textContent = 'Disconnected — reconnecting...';
      statusEl.className = 'disconnected';
      clearInterval(fpsTimer);
      setTimeout(connect, 2000);
    };

    ws.onerror = function() { ws.close(); };
  }

  connect();
})();
</script>
</body>
</html>`;

const clients = new Set<WebSocket>();

export async function startStream(): Promise<void> {
  // Capture latest frame from the emulator's PassThrough stream
  frameStream.on("data", (chunk: Buffer) => {
    if (chunk.length >= FRAME_BYTES) {
      latestFrame = chunk.subarray(0, FRAME_BYTES);
    }
  });

  // HTTP server — serves the canvas page
  server = http.createServer((_req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    res.end(HTML_PAGE);
  });

  // WebSocket server — streams frames
  wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
  });

  // Broadcast latest frame to all clients at WS_FPS
  broadcastTimer = setInterval(() => {
    if (!latestFrame || clients.size === 0) return;
    const frame = latestFrame;
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(frame, { binary: true });
      }
    }
  }, WS_INTERVAL);

  server.listen(PORT, () => {
    console.log(`[Canvas] Game Boy display at http://localhost:${PORT} (${WS_FPS}fps over WebSocket)`);
  });
}

export function stopStream(): void {
  if (broadcastTimer) {
    clearInterval(broadcastTimer);
    broadcastTimer = null;
  }
  for (const ws of clients) {
    ws.close();
  }
  clients.clear();
  if (wss) {
    wss.close();
    wss = null;
  }
  if (server) {
    server.close();
    server = null;
  }
}
