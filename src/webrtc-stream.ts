/**
 * WebRTC-based Game Boy stream with DataChannel compression
 * Much more efficient than raw WebSocket frames
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
// @ts-ignore - @koush/wrtc doesn't have TypeScript definitions
import { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } from "@koush/wrtc";
import { deflate } from "node:zlib";
import { promisify } from "node:util";
import {
  getLatestFrameRef,
  subscribeFrames,
  GB_WIDTH,
  GB_HEIGHT,
  type FrameMeta,
} from "./emulator.js";
import { config } from "./config.js";

const deflateAsync = promisify(deflate);

interface WebRTCClient {
  id: string;
  pc: RTCPeerConnection;
  dataChannel: RTCDataChannel | null;
  signalWs: WebSocket;
  connectedAtMs: number;
}

interface StreamStats {
  producedFrames: number;
  sentFrames: number;
  droppedFrames: number;
  activeClients: number;
  avgCompressRatio: number;
  avgFrameSizeBytes: number;
}

const webrtcClients = new Map<string, WebRTCClient>();
let httpServer: Server | null = null;
let signalWss: WebSocketServer | null = null;
let unsubscribeFrames: (() => void) | null = null;
let latestFrame: Buffer | null = null;

const stats: StreamStats = {
  producedFrames: 0,
  sentFrames: 0,
  droppedFrames: 0,
  activeClients: 0,
  avgCompressRatio: 0,
  avgFrameSizeBytes: 0,
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
  <title>MezoSbot WebRTC Stream</title>
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
    <h1>MezoSbot WebRTC Stream</h1>
    <p>Low-latency compressed streaming via WebRTC DataChannel</p>
    <canvas id="canvas" width="${GB_WIDTH}" height="${GB_HEIGHT}"></canvas>
    <div class="status" id="status">Connecting...</div>
  </div>
  <script>
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d', { alpha: false });
    const status = document.getElementById('status');
    ctx.imageSmoothingEnabled = false;

    let pc = null;
    let dataChannel = null;
    let signalWs = null;
    let frameCount = 0;
    let lastFpsUpdate = Date.now();
    let reconnectTimer = null;

    function connect() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      signalWs = new WebSocket(protocol + '//' + window.location.host + '/signal');

      signalWs.onopen = async () => {
        status.textContent = 'Signaling connected, setting up WebRTC...';

        // Create peer connection
        pc = new RTCPeerConnection({
          iceServers: [{ urls: '${config.streaming.stunServers.join("','")}' }]
        });

        // Handle ICE candidates
        pc.onicecandidate = (event) => {
          if (event.candidate) {
            signalWs.send(JSON.stringify({ type: 'ice', candidate: event.candidate }));
          }
        };

        // Connection state changes
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'connected') {
            status.textContent = 'Connected';
            status.style.color = '#10b981';
          } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            status.textContent = 'Disconnected - reconnecting...';
            status.style.color = '#f59e0b';
            clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(connect, 2000);
          }
        };

        // Handle incoming data channel
        pc.ondatachannel = (event) => {
          dataChannel = event.channel;

          dataChannel.onopen = () => {
            frameCount = 0;
            lastFpsUpdate = Date.now();
          };

          dataChannel.onmessage = async (event) => {
            // Decompress and render frame
            const compressed = await event.data.arrayBuffer();
            const decompressed = await decompressFrame(compressed);

            const rgba = new Uint8ClampedArray(decompressed);
            const imageData = new ImageData(rgba, ${GB_WIDTH}, ${GB_HEIGHT});
            ctx.putImageData(imageData, 0, 0);

            // Update FPS counter
            frameCount++;
            const now = Date.now();
            if (now - lastFpsUpdate >= 1000) {
              status.textContent = 'Connected - ' + frameCount + ' fps';
              frameCount = 0;
              lastFpsUpdate = now;
            }
          };
        };

        // Create offer
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        signalWs.send(JSON.stringify({ type: 'offer', sdp: offer }));
      };

      signalWs.onmessage = async (event) => {
        const msg = JSON.parse(event.data);

        if (msg.type === 'answer') {
          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        } else if (msg.type === 'ice') {
          await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        }
      };

      signalWs.onerror = () => {
        status.textContent = 'Connection error';
        status.style.color = '#ef4444';
      };

      signalWs.onclose = () => {
        if (pc) pc.close();
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 2000);
      };
    }

    // Decompress frame using browser's native DecompressionStream
    async function decompressFrame(compressed) {
      const ds = new DecompressionStream('deflate');
      const writer = ds.writable.getWriter();
      writer.write(new Uint8Array(compressed));
      writer.close();

      const chunks = [];
      const reader = ds.readable.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
      const result = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      return result.buffer;
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
  const client = webrtcClients.get(id);
  if (!client) return;

  try {
    if (client.dataChannel) client.dataChannel.close();
    client.pc.close();
    client.signalWs.close();
  } catch {
    // no-op
  }

  webrtcClients.delete(id);
  stats.activeClients = webrtcClients.size;
  console.log(`[WebRTC] Client ${id} disconnected (${webrtcClients.size} active)`);
}

async function broadcastFrame(rgba: Buffer): Promise<void> {
  if (webrtcClients.size === 0) return;

  // Compress frame once for all clients
  const compressed = await deflateAsync(rgba);
  const compressRatio = rgba.length / compressed.length;
  stats.avgCompressRatio = stats.avgCompressRatio === 0 ? compressRatio : stats.avgCompressRatio * 0.9 + compressRatio * 0.1;
  stats.avgFrameSizeBytes = stats.avgFrameSizeBytes === 0 ? compressed.length : stats.avgFrameSizeBytes * 0.9 + compressed.length * 0.1;

  const deadClients: string[] = [];

  for (const client of webrtcClients.values()) {
    if (!client.dataChannel || client.dataChannel.readyState !== "open") {
      if (client.pc.connectionState === "failed" || client.pc.connectionState === "closed") {
        deadClients.push(client.id);
      }
      continue;
    }

    try {
      // Check buffered amount (backpressure)
      if (client.dataChannel.bufferedAmount > 1024 * 1024) {
        stats.droppedFrames++;
        continue;
      }

      client.dataChannel.send(compressed);
      stats.sentFrames++;
    } catch (err) {
      deadClients.push(client.id);
    }
  }

  for (const id of deadClients) {
    removeClient(id);
  }
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
      stream: stats,
    });
    return;
  }

  if (method === "GET" && url.pathname === "/metrics") {
    sendJson(res, 200, { stream: stats });
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

export async function startStream(): Promise<void> {
  if (httpServer) return;

  // Subscribe to emulator frames
  unsubscribeFrames = subscribeFrames((meta) => {
    const ref = getLatestFrameRef();
    if (ref) {
      latestFrame = ref.frame;
      stats.producedFrames++;

      // Broadcast to all WebRTC clients
      broadcastFrame(ref.frame).catch((err) => {
        console.error("[WebRTC] Broadcast error:", (err as Error)?.message ?? err);
      });
    }
  });

  await new Promise<void>((resolve) => {
    httpServer = createServer((req, res) => {
      handleHttpRequest(req, res).catch((err) => {
        console.error("[WebRTC] HTTP handler error:", (err as Error)?.message ?? err);
        sendJson(res, 500, { error: "internal_error" });
      });
    });

    // WebSocket signaling server
    signalWss = new WebSocketServer({
      server: httpServer,
      path: "/signal",
    });

    signalWss.on("connection", async (ws: WebSocket) => {
      const clientId = `rtc-${Date.now()}-${Math.random().toString(36).substring(7)}`;

      const pc = new RTCPeerConnection({
        iceServers: config.streaming.stunServers.map((url) => ({ urls: url })),
      });

      const dataChannel = pc.createDataChannel("frames", {
        ordered: false, // Allow out-of-order for lower latency
        maxRetransmits: 0, // Don't retransmit - just drop old frames
      });

      webrtcClients.set(clientId, {
        id: clientId,
        pc,
        dataChannel,
        signalWs: ws,
        connectedAtMs: Date.now(),
      });
      stats.activeClients = webrtcClients.size;

      console.log(`[WebRTC] Client ${clientId} connecting (${webrtcClients.size} active)`);

      pc.onicecandidate = (event: any) => {
        if (event.candidate) {
          ws.send(JSON.stringify({ type: "ice", candidate: event.candidate }));
        }
      };

      ws.on("message", async (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.type === "offer") {
            await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            ws.send(JSON.stringify({ type: "answer", sdp: answer }));
          } else if (msg.type === "ice") {
            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          }
        } catch (err) {
          console.error("[WebRTC] Signaling error:", (err as Error)?.message ?? err);
        }
      });

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

  console.log(`[WebRTC] Stream ready at ${streamBaseUrl()}/`);
  console.log(`[WebRTC] ${GB_WIDTH}x${GB_HEIGHT} @ 60fps with DataChannel compression`);
}

export function stopStream(): void {
  if (unsubscribeFrames) {
    unsubscribeFrames();
    unsubscribeFrames = null;
  }
  for (const id of webrtcClients.keys()) {
    removeClient(id);
  }
  if (signalWss) {
    signalWss.close();
    signalWss = null;
  }
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
}
