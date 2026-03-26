# Production environment: low latency and operations

This document describes how to run the product in production for **low latency** and **sound operations**. It is aligned with this stack: React SPA, REST API, Prisma/DB, Socket.IO signaling, and WebRTC.

---

## 1. Placement and networking

### Regions

Run API, signaling (Socket.IO), and database in the **same region** (or as close as policy allows). Cross-region hops dominate latency for REST, WebSockets, and DB round-trips.

### Edge for static assets

Serve the built SPA (HTML/JS/CSS, fonts, images) from a **CDN** close to users. That reduces time-to-interactive; it does **not** replace co-locating realtime services with users.

### DNS and TLS

Use a DNS provider with **low TTL** only where fast failover is required; otherwise moderate TTL reduces resolver churn. Terminate TLS at the **edge or load balancer** with **HTTP/2 or HTTP/3** so the browser can multiplex requests efficiently.

### WebRTC path

Media is mostly **peer-to-peer** after setup; perceived latency is driven by **signaling RTT** (Socket.IO to your server) and **ICE/STUN/TURN**. For production, deploy **TURN** (see [WebRTC](#4-webrtc-specific-production-setup)) and run signaling **near** your main user bases.

---

## 2. Application and API layer

### Stateless API servers

Scale horizontally behind a load balancer. Prefer **JWT/cookies** with shared validation over sticky sessions unless unavoidable. For Socket.IO at scale, stateless patterns and a shared adapter (see [Realtime](#3-realtime-socketio-and-signaling)) matter more than HTTP stickiness alone.

### Connection pooling

Configure the DB driver/ORM (**Prisma**) with a **bounded pool**. Size so total connections stay under the database limit:

`total ≈ (API instances × pool size per instance) + admin/migration overhead`

### Caching

- **Short-lived cache** for read-heavy, low-risk data (CDN or reverse proxy with correct `Cache-Control`).
- **Application cache** (e.g. Redis) for hot keys, rate limits, or session metadata if needed.
- Do not cache personalized or security-sensitive responses without strict rules.

### Payloads

Use **pagination**, **field selection**, and **compression** (Brotli/gzip at CDN/LB) for JSON. Smaller payloads reduce latency on constrained links.

### Background work

Move heavy CPU/IO (reports, emails, large transforms) to **queues/workers** so API workers stay responsive.

---

## 3. Realtime: Socket.IO and signaling

### Colocation

Run the Socket.IO server in the **same region** as the API/DB your users use.

### Scaling

With **multiple** Socket.IO nodes, use a **Redis (or similar) adapter** for pub/sub so rooms and events work across instances. Relying on sticky sessions alone **without** a shared adapter breaks correctness when traffic moves between nodes.

### Transport

Ensure **WebSocket** is allowed through proxies and load balancers (upgrade headers, appropriate idle timeouts). Overly aggressive **proxy read timeouts** cause reconnects and perceived lag.

### Client behavior

Use sensible **reconnection** with backoff; avoid chatty custom events—batch state updates when possible.

---

## 4. WebRTC-specific production setup

### STUN

Public STUN servers work for many NAT cases but are **not** sufficient for all networks.

### TURN (required for broad compatibility)

Deploy **managed TURN** (e.g. Twilio, Metered, Xirsys) or self-hosted **coturn** in regions close to users. Without TURN, some users will fail to connect or take poor network paths.

### ICE and firewalls

Document **UDP** (and sometimes **TCP**) requirements for TURN. Corporate firewalls may block UDP; **TCP TURN** is a fallback with higher latency but better connectivity.

### Codec and bitrate

Tune **resolution, frame rate, and bitrate** for your product; lower targets reduce latency and sensitivity to packet loss on poor networks.

---

## 5. Database and data path

### Primary placement

Keep the **primary** database in the same region as the application. Cross-region primary reads/writes add tens to hundreds of milliseconds per round-trip.

### Indexes and queries

Ensure hot-path queries are **indexed** and reviewed in production (slow query log, APM).

### Read replicas

Use replicas for **read scaling**; account for **replication lag** on “read your own write” flows—route critical reads to the primary when consistency requires it.

### Migrations

Prefer **backward-compatible** migrations and avoid long table locks during peak traffic.

---

## 6. Security and compliance (baseline)

### Secrets

Store secrets in a **secret manager** or inject via environment at runtime—never bake them into images or commit them to the repository.

### HTTPS

Enforce HTTPS end-to-end; use HSTS, modern TLS, and **secure** cookies for session tokens where applicable.

### Abuse and rate limiting

Apply **rate limits** at the edge or API; add bot protection where needed. Consider **per-IP or per-user** limits on Socket.IO connections for public endpoints.

### Dependencies

Use automated **vulnerability scanning** and pinned versions for production builds.

---

## 7. Reliability and operations

### Health checks

Implement **liveness** and **readiness** probes that validate **database** and **Redis** (if used) so unhealthy instances stop receiving traffic.

### Graceful shutdown

Drain connections and finish in-flight work before exit—especially important for WebSockets.

### Backups and recovery

Automate database **backups**, test **restores**, and document **RPO/RTO** targets.

### Deployments

Ship **immutable artifacts**; use **blue/green** or **rolling** deploys with a fast **rollback** path.

---

## 8. Observability

### Metrics

Track request latency (**p50 / p95 / p99**), error rates, saturation (CPU, memory, DB connections), Socket.IO **connected clients**, and **reconnect** rate.

### Tracing

Use **distributed tracing** from API through database for slow-request diagnosis.

### Logging

Use **structured** logs and **correlation IDs**; never log secrets or full tokens.

### Synthetic monitoring

Probe critical HTTP endpoints and a **minimal signaling** path from multiple regions.

### Real User Monitoring (RUM)

Capture web vitals and client-side API timing to see geographic and device reality.

---

## 9. Checklist summary

| Area        | Low-latency / proper action                                              |
| ----------- | ------------------------------------------------------------------------ |
| Geography   | Same region: app + DB + signaling; CDN for static assets                 |
| WebRTC      | TURN in-region; STUN + documented firewall requirements                 |
| Socket.IO   | WebSocket-friendly LB; Redis adapter if multi-node                       |
| API         | Connection pooling, lean payloads, async heavy work                      |
| Database    | Indexes, bounded pools, backups, slow-query monitoring                   |
| Edge        | HTTP/2 or HTTP/3, compression, cache static assets                       |
| Operations  | Health checks, metrics, tracing, RUM, runbooks                           |

---

## 10. Codebase pointers

Client realtime configuration lives in `client/src/pages/MeetingPage.tsx` (e.g. `ICE_SERVERS`, signaling URL). Production should use **environment-driven** ICE server configuration and ensure the signaling URL matches your deployed API/WebSocket origin.

Recommended browser environment variables (Vite):

- `VITE_ICE_STUN_URLS`: comma-separated STUN URLs (optional; defaults are used if omitted)
- `VITE_ICE_TURN_URLS`: comma-separated TURN/TURNS URLs
- `VITE_ICE_TURN_USERNAME`: TURN username
- `VITE_ICE_TURN_CREDENTIAL`: TURN credential/password

---

*Last updated: March 2026*
