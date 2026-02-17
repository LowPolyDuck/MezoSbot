# Streaming Fallback Split

If Render is stable for bot logic but not for low-latency media delivery, split the deployment:

1. Keep `MezoSbot` (Discord bot + emulator + game state) on Render.
2. Move WebRTC publishing to a separate low-latency worker (Fly.io/Railway/region-closer VM).
3. Forward only frame payload + metadata from bot service to media service.

## Why this split works

- Bot + DB operations are latency-tolerant and fit Render well.
- Real-time media is sensitive to jitter and packet pacing.
- Isolating media lets you tune CPU/network independently without touching game logic.

## Interface contract to keep stable

- Frame format: RGBA `160x144`, fixed size.
- Metadata: `seq`, `capturedAtMs`, `width`, `height`.
- Policy: consumer should always prefer newest frame and drop stale frames.

## Migration steps

1. Keep current frame publisher API in emulator (`subscribeFrames`, `getLatestFrameCopy`).
2. Add transport adapter in bot service:
   - local mode: publish directly to in-process WebRTC.
   - remote mode: POST/UDP publish to media worker.
3. Reuse same browser signaling + viewer UX on the media worker.
4. Compare `/metrics` between local and split mode before cutover.
