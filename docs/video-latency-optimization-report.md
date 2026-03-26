# Video Latency Optimization Report (Bandr)

Date: 2026-03-26

## Executive Summary

- Your stack is already on the right base (WebRTC + Socket.IO signaling).
- The biggest remaining latency wins are:
  1) production TURN in user regions,
  2) geo placement of signaling,
  3) adaptive media constraints,
  4) instrumentation (p95/p99 + ICE candidate quality).
- Cloudflare R2 is useful for recordings/assets, but **not** for live media latency.

## Current Architecture Snapshot

- Client: Vite + React, WebRTC in `client/src/pages/MeetingPage.tsx`
- Realtime control plane: Socket.IO signaling server (`server/apps/signaling/src/index.ts`)
- ICE config: env-driven support for STUN/TURN (`VITE_ICE_*` variables already present)
- Dev transport: Vite proxy and ngrok usage observed (good for dev, not representative for production latency)

## Root Causes of Perceived "Low Latency Issues"

In real-time calls, user-visible delay generally comes from:

- Slow ICE path selection (no nearby TURN or relay fallback quality issues)
- High RTT to signaling (join/renegotiation/control feels sluggish)
- Packet loss/jitter on weak networks causing playout buffering
- Excessive video bitrate/resolution for current uplink/downlink
- TCP fallback over constrained links (connectivity improves but latency rises)

## Cloudflare R2: Should You Use It?

Short answer:

- **Use R2 for**: recordings, snapshots, whiteboard exports, chat attachments, media artifacts.
- **Do not use R2 for**: live call path, TURN relay, WebRTC packet transport.

Why:

- R2 is object storage (durable storage), not a realtime media relay.
- It does not reduce one-way media delay in a WebRTC session.

If you want Cloudflare for realtime acceleration:

- Consider Cloudflare edge/network products for HTTP/WebSocket delivery, but for WebRTC media quality you still need correctly placed TURN/SFU strategy.

## Priority Plan (Highest Impact First)

## P0 (Do Immediately)

1. Deploy managed TURN in at least 2 regions closest to user base.
   - Add both UDP and TCP/TLS TURN URLs.
   - Keep credentials rotated and monitored.
   - Verify relay usage rate and failure rate.

2. Co-locate signaling + API + DB by primary user geography.
   - Avoid cross-region signaling hops.
   - Keep signaling under low RTT for join/renegotiation events.

3. Enforce production ICE env values.
   - Set:
     - `VITE_ICE_TURN_URLS`
     - `VITE_ICE_TURN_USERNAME`
     - `VITE_ICE_TURN_CREDENTIAL`
   - Keep STUN defaults as backup only.

4. Remove dev tunnel assumptions when benchmarking.
   - ngrok adds extra hops and variable latency.
   - Benchmark only against production-like topology.

## P1 (Next 1-2 weeks)

5. Add adaptive media profiles.
   - Start with conservative defaults:
     - 720p max, 24fps, capped bitrate.
   - On poor network, downshift to:
     - 480p/360p and lower fps.

6. Add connection quality telemetry.
   - From `RTCPeerConnection.getStats()` capture:
     - RTT, jitter, packet loss, availableOutgoingBitrate, framesDropped.
   - Store p50/p95/p99 per region/network type.

7. Add transport metrics on signaling server.
   - Track:
     - connect time
     - reconnect rate
     - event ack durations
     - join approval timing

## P2 (Scale Architecture)

8. Introduce SFU for "best video platform" target.
   - P2P mesh becomes costly as participants grow.
   - For 4+ users, SFU typically gives better stability/latency tradeoff.
   - Options: LiveKit / mediasoup / Janus / Daily/Twilio managed.

9. Multi-region strategy.
   - Region affinity on join.
   - Closest signaling/SFU selection.
   - Cross-region fallback only when needed.

## Concrete Technical Recommendations

## WebRTC

- Keep `iceTransportPolicy: "all"` initially; monitor relay rates.
- Prefer VP8/H264 baseline compatibility first; optimize codec later.
- Add simulcast once SFU is introduced.
- Tune sender encodings (`maxBitrate`) to avoid congestion spikes.

## TURN

- Minimum production setup:
  - `turn:...:3478?transport=udp`
  - `turns:...:5349?transport=tcp`
- Use short-lived credentials when possible.
- Place TURN in same major geos as users.

## Signaling

- Single region is fine for early scale, but maintain low p95 RTT.
- If you run multiple signaling nodes, add Redis adapter for room consistency.
- Ensure LB/web proxy websocket timeouts are long enough.

## Product/UX for perceived latency

- Show quality indicator (Good/Fair/Poor).
- Auto-disable HD on poor quality.
- Fast reconnect UX on transient disconnects.
- Expose manual "Low bandwidth mode".

## KPIs for "Best Video Platform" Benchmark

Set SLO targets:

- Join-to-first-remote-frame: < 2.5s p95
- Audio one-way latency: < 150ms p95
- Reconnect recovery: < 3s p95
- Call failure rate: < 1%
- TURN allocation success: > 99%

## 30-Day Rollout Plan

Week 1:

- Deploy TURN (2 regions), configure env, verify ICE paths.

Week 2:

- Add client `getStats()` reporting + backend latency dashboards.

Week 3:

- Implement adaptive bitrate/resolution profile switching.

Week 4:

- Evaluate SFU proof-of-concept with 4-10 participant test rooms.

## Risks and Trade-offs

- TURN increases cost but dramatically improves connectivity/reliability.
- TCP/TLS TURN helps enterprise networks but can increase latency.
- SFU adds system complexity but is required for consistent multi-party quality at scale.

## Final Answer to Your R2 Question

- R2 is great for storage workflows around video.
- R2 is not the solution for live call latency.
- For latency, prioritize TURN placement + media adaptation + SFU roadmap.
