# Runbook: Docker (Postgres + Redis) then PM2

Run these on your **server** (or local machine) from the repo root unless noted.

## Part A — Docker

### 1. Install Docker Engine + Compose plugin

- Ubuntu: follow [Docker’s install docs](https://docs.docker.com/engine/install/).
- Confirm: `docker compose version`

### 2. Create root `.env` (gitignored)

At the repo root, create `.env` with:

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/meetclone"
REDIS_URL="redis://localhost:6380"
```

(`packages/db` scripts use this file via `dotenv -e ../../.env`.)

### 3. Start containers

```bash
cd /path/to/bandr
docker compose up -d
```

### 4. Verify

```bash
docker compose ps
docker exec meetclone-postgres pg_isready -U postgres -d meetclone
```

You should see Postgres **healthy** and Redis **up**.

### 5. Stop / restart (optional)

```bash
docker compose down          # stop (data kept in volumes)
docker compose up -d         # start again
```

---

## Part B — App build + database migrations

### 6. Install Node 20+ and dependencies

```bash
cd /path/to/bandr
npm ci
```

Use the **repo root** for installs (`npm ci` / `npm install`). Running install only inside `apps/api` skips workspace linking and can break `@bandr/db` resolution at build or runtime.

The **absolute** path on the server (e.g. `/var/www/docker/video`) does not matter. What matters is a **normal monorepo checkout**: root `package.json` with workspaces, plus `apps/` and `packages/` as in this repo. TypeScript and Node resolve `@bandr/db` via the workspace link under the root `node_modules`, not via a hardcoded filesystem path.

### 7. Configure app env files

Create **`apps/api/.env`** and **`apps/signaling/.env`** (not committed). Minimum:

**`apps/api/.env`**

```env
NODE_ENV=production
HOST=127.0.0.1
PORT=4001
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/meetclone"
REDIS_URL="redis://localhost:6380"
JWT_SECRET="<long-random-string>"
SIGNALING_URL="http://127.0.0.1:4002"
```

**`apps/signaling/.env`**

```env
NODE_ENV=production
HOST=127.0.0.1
PORT=4002
JWT_SECRET="<same-as-api>"
```

(Use real secrets in production; `JWT_SECRET` must match between API and signaling.)

### 8. Build the monorepo

```bash
npm run build
```

To run **API + signaling in the foreground** (no PM2), from repo root:

```bash
npm run start
```

### 9. Run Prisma migrations

```bash
npm run db:migrate -w @bandr/db
```

If prompted, name the migration or apply existing migrations. Ensure root `.env` exists so `DATABASE_URL` is loaded.

---

## Part C — PM2

### 10. Install PM2 globally

```bash
sudo npm i -g pm2
```

### 11. Start API + signaling

From **repo root**:

```bash
pm2 start deploy/pm2.ecosystem.example.cjs
pm2 status
```

### 12. Persist across reboot

```bash
pm2 save
pm2 startup
# Run the command PM2 prints (sudo env …)
```

### 13. Logs and restarts

```bash
pm2 logs
pm2 restart bandr-api bandr-signaling
```

---

## Part D — Nginx (optional)

Put TLS + reverse proxy in front: see `deploy/nginx.example.conf` (e.g. `video.upliftsolutions.com.np` → `127.0.0.1:4001` and `/socket.io/` → `127.0.0.1:4002`).

---

## Quick check

- API: `curl -s http://127.0.0.1:4001/health`
- Signaling: `curl -s http://127.0.0.1:4002/health`

Both should return JSON with `"status":"ok"` (or similar).
