# LiveKit dev troubleshooting

## `curl: (52) Empty reply from server` to `http://localhost:4001`

Your API often runs **HTTPS** on port 4001 (see `HTTPS_KEY_PATH` / `HTTPS_CERT_PATH` in `server/apps/api/.env`). Plain HTTP to an HTTPS port gives a bad handshake and **empty reply**.

Use:

```bash
curl -k -i https://localhost:4001/health
```

For the LiveKit token (needs a real JWT from login):

```bash
curl -k -i -X POST \
  -H "Authorization: Bearer YOUR_JWT" \
  https://localhost:4001/api/meetings/YOUR_MEETING_CODE/livekit/token
```

- `-k` skips verifying a self-signed / mkcert cert (dev only).

## `POST /api/meetings/:code/livekit/token` → **404**

Possible causes:

1. **Meeting code does not exist in your local DB**  
   The handler returns 404 when `prisma.meeting.findUnique` finds nothing. Create a meeting while logged in, or use a code that exists in the same database your API uses.

2. **API process is old** (no route yet)  
   Rebuild/restart the API after pulling: `npm run build -w api` (or your `yarn` workspace command) and restart `api`.

3. **Vite proxy points at the wrong target**  
   `client/.env` → `VITE_API_PROXY_TARGET` must match how the API listens:

   - API **HTTP** on 4001 → `VITE_API_PROXY_TARGET=http://localhost:4001`
   - API **HTTPS** on 4001 → `VITE_API_PROXY_TARGET=https://localhost:4001`  
     (`vite.config.ts` uses `secure: false` so self-signed works.)

   Restart Vite after changing this.

## `POST .../livekit/token` → **503**

`LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` must be set in `server/apps/api/.env`.

## Browser: `Cross-Origin-Opener-Policy policy would block the window.postMessage`

Often from **Google Sign-In** or **Vite HMR** in dev. It is usually **benign** unless Google login actually fails. If GIS breaks, try another browser profile or disable strict COOP on the page that embeds GIS (advanced).
