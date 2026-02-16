/**
 * Web Canvas display — HTTP server + WebSocket frame streaming.
 *
 * Optimizations for steady FPS:
 * 1. zlib compression — ~92KB raw → ~3-8KB compressed (Game Boy has few colors)
 *    Compressed once per frame, shared across all clients.
 * 2. Skip identical frames — no wasted bandwidth when screen is static.
 * 3. Per-client backpressure — drop frames for slow clients instead of buffering.
 *
 * Client decompresses with the built-in DecompressionStream API.
 */
import http from "node:http";
import { deflateRawSync } from "node:zlib";
import { WebSocketServer, type WebSocket } from "ws";
import { frameStream, GB_WIDTH, GB_HEIGHT } from "./emulator.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const WS_FPS = 20;
const WS_INTERVAL = 1000 / WS_FPS;
const FRAME_BYTES = GB_WIDTH * GB_HEIGHT * 4;
const MAX_BUFFERED = 32 * 1024; // drop frames if client has >32KB queued

let latestCompressed: Buffer | null = null;
let frameChanged = false;
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
  var W = ${GB_WIDTH}, H = ${GB_HEIGHT}, SCALE = 3;
  var BYTES = W * H * 4;
  var canvas = document.getElementById('gb');
  canvas.style.width = (W * SCALE) + 'px';
  canvas.style.height = (H * SCALE) + 'px';
  var ctx = canvas.getContext('2d');
  var img = ctx.createImageData(W, H);
  var statusEl = document.getElementById('status');
  var frames = 0, lastFps = 0, fpsTimer;

  function inflate(compressed) {
    var ds = new DecompressionStream('deflate-raw');
    var writer = ds.writable.getWriter();
    writer.write(compressed);
    writer.close();
    return new Response(ds.readable).arrayBuffer();
  }

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var ws = new WebSocket(proto + '//' + location.host + '/ws');
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
      if (!(e.data instanceof ArrayBuffer) || e.data.byteLength === 0) return;
      if (e.data.byteLength === BYTES) {
        img.data.set(new Uint8ClampedArray(e.data));
        ctx.putImageData(img, 0, 0);
        frames++;
      } else {
        inflate(e.data).then(function(raw) {
          if (raw.byteLength >= BYTES) {
            img.data.set(new Uint8ClampedArray(raw, 0, BYTES));
            ctx.putImageData(img, 0, 0);
            frames++;
          }
        }).catch(function() {});
      }
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
  // Capture frames, compress once, share with all clients
  frameStream.on("data", (chunk: Buffer) => {
    if (chunk.length < FRAME_BYTES) return;
    // Compress once — level 1 is fastest, Game Boy palette compresses ~10:1
    latestCompressed = deflateRawSync(chunk.subarray(0, FRAME_BYTES), { level: 1 });
    frameChanged = true;
  });

  server = http.createServer((_req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    res.end(HTML_PAGE);
  });

  wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
  });

  // Broadcast compressed frame to all clients
  broadcastTimer = setInterval(() => {
    if (!latestCompressed || !frameChanged || clients.size === 0) return;
    frameChanged = false;
    const compressed = latestCompressed;

    for (const ws of clients) {
      // Skip clients that are backed up — they'll get the next frame
      if (ws.readyState === ws.OPEN && ws.bufferedAmount < MAX_BUFFERED) {
        ws.send(compressed, { binary: true });
      }
    }
  }, WS_INTERVAL);

  server.listen(PORT, () => {
    console.log(`[Canvas] Game Boy display at http://localhost:${PORT} (${WS_FPS}fps, zlib compressed)`);
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
