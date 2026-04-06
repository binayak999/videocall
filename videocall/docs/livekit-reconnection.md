# LiveKit reconnection (Bandr)

## Issues addressed

1. **SDK reconnect exhaustion** — `DefaultReconnectPolicy` stops after a fixed number of attempts; the client never fetched a new token or created a new `Room`, so users stayed dead in-call.
2. **No handler for `RoomEvent.Disconnected`** — Unexpected SFU drops were invisible; no toast, no recovery path.
3. **Stale `Room` after drop** — The UI still assumed a connected session even though media was gone.
4. **Intentional leave vs crash** — `room.disconnect()` emits `Disconnected` with `CLIENT_INITIATED`; we must not auto-reconnect when the user leaves or resets the call.
5. **Peer list for flush** — Full reconnect must use the same socket peer ids as the initial join so pending LiveKit tracks still map after reconnect (`liveKitPeerIdsRef`).

## Behavior

- On **retryable** `DisconnectReason`, while `callView === 'call'`, RTC mode is LiveKit, and signaling socket is connected: schedule a **full reconnect** (new JWT from API, new `Room`, re-publish camera/mic, re-attach remote tracks).
- **Exponential backoff** with jitter (`liveKitFullReconnectDelayMs` in `client/src/lib/livekitReconnection.ts`).
- **Max attempts** (`LIVEKIT_FULL_RECONNECT_MAX_ATTEMPTS`, default 10) then a toast; user can leave and rejoin.
- **`RoomEvent.Reconnecting` / `Reconnected`** — Log + toast “restoring…”; reset failure count on SDK `Reconnected`.
- **Tests** — `yarn test:unit` in `client/` runs `livekitReconnection.test.ts`.

## Operations

- Ensure `LIVEKIT_*` env and token route stay available during outages.
- For HA LiveKit, use server docs (Redis, etc.); this client path is a safety net when the session is still lost.
