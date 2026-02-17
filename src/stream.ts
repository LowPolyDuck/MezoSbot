/**
 * Browser stream transport:
 * - HTTP signaling endpoint for WebRTC session setup.
 * - Server-side frame pacing with newest-frame drop policy.
 * - Health + stream metrics for cloud tuning.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import {
  getLatestFrameCopy,
  subscribeFrames,
  GB_WIDTH,
  GB_HEIGHT,
  STREAM_FPS,
  type FrameMeta,
} from "./emulator.js";
import { config } from "./config.js";
import { rgbaToI420 } from "./streaming/rgbaToI420.js";

let RTCPeerConnection: any;
let RTCSessionDescription: any;
let RTCVideoSource: any;
let MediaStream: any;

interface StreamClient {
  id: string;
  pc: InstanceType<typeof RTCPeerConnection>;
  source: any;
  track: any;
  stream: any;
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
const i420Buffer = Buffer.alloc(Math.floor((GB_WIDTH * GB_HEIGHT * 3) / 2));
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
    video { width: ${ws}px; height: ${hs}px; image-rendering: pixelated; border-radius: 12px; border: 1px solid #1d2330; background: black; }
    .row { display: flex; gap: 10px; align-items: center; margin-top: 12px; }
    button { border: 0; border-radius: 8px; background: #2463eb; color: white; padding: 10px 14px; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    code { background: #121725; border-radius: 6px; padding: 2px 6px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>MezoSbot Browser Stream</h1>
    <p>Low-latency viewer. If stream stalls, press reconnect.</p>
    <video id="video" autoplay playsinline muted></video>
    <div class="row">
      <button id="connect">Connect</button>
      <span id="status">idle</span>
    </div>
    <div class="row">
      <small>Signaling: <code>/api/webrtc/offer</code></small>
    </div>
  </div>
  <script>
    const statusEl = document.getElementById("status");
    const connectBtn = document.getElementById("connect");
    const video = document.getElementById("video");
    let pc = null;

    async function waitForIceGathering(pc) {
      if (pc.iceGatheringState === "complete") return;
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 2000);
        pc.addEventListener("icegatheringstatechange", () => {
          if (pc.iceGatheringState === "complete") {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
    }

    async function connect() {
      connectBtn.disabled = true;
      statusEl.textContent = "connecting";
      if (pc) pc.close();

      pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
      pc.ontrack = (event) => {
        console.log("ontrack event:", event);
        console.log("streams:", event.streams);
        console.log("track:", event.track);
        if (event.streams && event.streams[0]) {
          console.log("Setting video srcObject to stream:", event.streams[0]);
          video.srcObject = event.streams[0];
        } else {
          console.warn("No streams in track event, creating manual MediaStream");
          const stream = new MediaStream([event.track]);
          video.srcObject = stream;
        }
      };
      pc.onconnectionstatechange = () => {
        console.log("Connection state:", pc.connectionState);
        statusEl.textContent = pc.connectionState;
      };

      const offer = await pc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: false });
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc);

      const res = await fetch("/api/webrtc/offer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sdp: pc.localDescription.sdp, type: pc.localDescription.type }),
      });

      if (!res.ok) {
        throw new Error("signaling failed");
      }

      const answer = await res.json();
      await pc.setRemoteDescription(answer);
      statusEl.textContent = "connected";
      connectBtn.disabled = false;
    }

    connectBtn.addEventListener("click", () => {
      connect().catch((err) => {
        statusEl.textContent = "error: " + err.message;
        connectBtn.disabled = false;
      });
    });
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

function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

async function waitForIceGatheringComplete(pc: InstanceType<typeof RTCPeerConnection>): Promise<void> {
  if (pc.iceGatheringState === "complete") return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      resolve();
    }, 2000);
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
}

function removeClient(id: string): void {
  const client = streamClients.get(id);
  if (!client) return;
  try {
    client.pc.close();
  } catch {
    // no-op
  }
  try {
    client.track.stop();
  } catch {
    // no-op
  }
  streamClients.delete(id);
  stats.activeClients = streamClients.size;
}

async function handleOfferRequest(res: ServerResponse, body: any): Promise<void> {
  const offerSdp = body?.sdp;
  const offerType = body?.type;
  if (!offerSdp || offerType !== "offer") {
    sendJson(res, 400, { error: "invalid_offer" });
    return;
  }

  const clientId = randomUUID();
  const pc = new RTCPeerConnection({
    iceServers: config.streaming.stunServers.map((urls) => ({ urls })),
  });

  pc.addEventListener("connectionstatechange", () => {
    const state = pc.connectionState;
    if (state === "failed" || state === "disconnected" || state === "closed") {
      removeClient(clientId);
    }
  });

  // Set remote description to see what the client wants
  await pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: offerSdp }));

  // Create video source and track
  const source = new RTCVideoSource();
  const track = source.createTrack();

  // Send an initial black frame to activate the track
  const blackFrame = Buffer.alloc(Math.floor((GB_WIDTH * GB_HEIGHT * 3) / 2), 0);
  source.onFrame({
    width: GB_WIDTH,
    height: GB_HEIGHT,
    data: blackFrame,
  });

  // Check transceivers and add track
  console.log(`[Stream] Transceivers:`, pc.getTransceivers().length);
  const transceivers = pc.getTransceivers();
  const videoTransceiver = transceivers.find((t: any) => t.receiver?.track?.kind === "video");

  if (videoTransceiver) {
    console.log(`[Stream] Found existing video transceiver, direction: ${videoTransceiver.direction}`);
    await videoTransceiver.sender.replaceTrack(track);
    videoTransceiver.direction = "sendonly";
  } else {
    console.log(`[Stream] No existing transceiver, adding track`);
    pc.addTrack(track);
  }

  const stream = new MediaStream([track]);

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  console.log(`[Stream] Answer created, video transceivers:`,
    pc.getTransceivers().filter((t: any) => t.receiver?.track?.kind === "video").length);
  await waitForIceGatheringComplete(pc);

  streamClients.set(clientId, {
    id: clientId,
    pc,
    source,
    track,
    stream,
    connectedAtMs: Date.now(),
  });
  stats.activeClients = streamClients.size;

  console.log(`[Stream] Client ${clientId} connected (${streamClients.size} active)`);

  const local = pc.localDescription;
  sendJson(res, 200, { type: local.type, sdp: local.sdp });
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

  if (method === "POST" && url.pathname === "/api/webrtc/offer") {
    try {
      const body = await readJsonBody(req);
      await handleOfferRequest(res, body);
    } catch {
      sendJson(res, 400, { error: "invalid_json" });
    }
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

function pushFrameToClients(rgba: Buffer): void {
  if (streamClients.size === 0) return;
  const encodeStart = Date.now();
  const { data } = rgbaToI420(rgba, GB_WIDTH, GB_HEIGHT, i420Buffer);
  for (const client of streamClients.values()) {
    try {
      client.source.onFrame({
        width: GB_WIDTH,
        height: GB_HEIGHT,
        data,
      });
    } catch (err) {
      console.error(`[Stream] Failed to send frame to client ${client.id}:`, (err as Error)?.message ?? err);
      removeClient(client.id);
    }
  }
  stats.encodedFrames += 1;
  const elapsed = Date.now() - encodeStart;
  stats.avgEncodeMs = stats.avgEncodeMs === 0 ? elapsed : (stats.avgEncodeMs * 0.9) + (elapsed * 0.1);
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

export async function startStream(): Promise<void> {
  if (httpServer) return;
  ensureWebRtcRuntime();

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

  console.log(`[Stream] Browser viewer ready at ${streamBaseUrl()}/`);
  console.log(`[Stream] Health endpoint: ${streamBaseUrl()}/healthz`);
  console.log(`[Stream] ${GB_WIDTH}x${GB_HEIGHT} source | encode ${requestedFps}fps (min ${minFps}) | emulator ${STREAM_FPS}fps`);
}

function ensureWebRtcRuntime(): void {
  if (RTCPeerConnection && RTCSessionDescription && RTCVideoSource && MediaStream) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const wrtc = require("@roamhq/wrtc");
    RTCPeerConnection = wrtc.RTCPeerConnection;
    RTCSessionDescription = wrtc.RTCSessionDescription;
    RTCVideoSource = wrtc.nonstandard?.RTCVideoSource;
    MediaStream = wrtc.MediaStream;
  } catch {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const wrtc = require("wrtc");
      RTCPeerConnection = wrtc.RTCPeerConnection;
      RTCSessionDescription = wrtc.RTCSessionDescription;
      RTCVideoSource = wrtc.nonstandard?.RTCVideoSource;
      MediaStream = wrtc.MediaStream;
    } catch {
      throw new Error("WebRTC runtime unavailable. Install `@roamhq/wrtc` (preferred) and ensure native binaries are present.");
    }
  }
  if (!RTCPeerConnection || !RTCSessionDescription || !RTCVideoSource || !MediaStream) {
    throw new Error("WebRTC runtime unavailable. Install `@roamhq/wrtc` (preferred) and ensure native binaries are present.");
  }
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
