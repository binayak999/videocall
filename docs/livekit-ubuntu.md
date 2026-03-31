# LiveKit on Ubuntu (self-hosted) — setup guide

This repo can join LiveKit rooms when:

- API has `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
- Client has `VITE_USE_LIVEKIT=1`

The API endpoint that mints join tokens is:

- `POST /api/meetings/:code/livekit/token` (requires your existing JWT auth)

## 1) Provision the server

Recommended baseline:

- Ubuntu 22.04/24.04
- 2+ vCPU, 4GB+ RAM (more for higher concurrency)
- A public domain like `livekit.yourdomain.com`
- A trusted TLS cert (Let’s Encrypt)

## 2) Open firewall ports

LiveKit needs:

- **TCP 80/443** (reverse proxy / TLS termination)
- **TCP 7880** (LiveKit HTTP/WebSocket behind proxy, or directly if you terminate TLS elsewhere)
- **TCP 7881** (ICE/TCP fallback)
- **UDP 50000–60000** (media)

If you enable LiveKit embedded TURN:

- **TCP 5349** (TURN/TLS) or **TCP 443** if you run TURN/TLS on 443
- optionally **UDP 443** (TURN/UDP on 443)

Docs: `https://docs.livekit.io/home/self-hosting/ports-firewall`

## 3) Install Docker + Compose

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo $VERSION_CODENAME) stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER
```

Log out/in (or reboot) so your user can run docker without sudo.

## 4) Create LiveKit config

Create a folder:

```bash
mkdir -p /opt/livekit
cd /opt/livekit
```

Create `livekit.yaml`:

```yaml
port: 7880
log_level: info

rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 60000
  use_external_ip: true

keys:
  # API key : API secret
  LK_API_KEY: LK_API_SECRET

# Optional but recommended for production (horizontal scaling):
# redis:
#   address: 127.0.0.1:6379

# TURN options:
# LiveKit includes an embedded TURN server. This is the easiest “works everywhere” option.
# If you already run a separate TURN server, you can keep using it, but LiveKit’s embedded TURN
# tends to be simpler because auth is integrated.
#
# TURN/TLS example (recommended):
# turn:
#   enabled: true
#   domain: turn.yourdomain.com
#   tls_port: 5349
#   cert_file: /etc/livekit/turn.crt
#   key_file: /etc/livekit/turn.key
```

Generate **real** values:

- Replace `LK_API_KEY` with something like `LKxxxxxxxx`
- Replace `LK_API_SECRET` with a long random secret

## 5) Run LiveKit with Docker Compose

Create `docker-compose.yml`:

```yaml
services:
  livekit:
    image: livekit/livekit-server:latest
    command: --config /etc/livekit/livekit.yaml
    network_mode: "host"
    restart: unless-stopped
    volumes:
      - ./livekit.yaml:/etc/livekit/livekit.yaml:ro
```

Start:

```bash
docker compose up -d
docker logs -f --tail=200 $(docker ps -q --filter name=livekit)
```

## 6) Put TLS in front (recommended)

LiveKit docs recommend **TLS termination** with a reverse proxy / load balancer. Typical setup:

- `livekit.yourdomain.com` → reverse proxy to `http://127.0.0.1:7880`
- TLS cert via Let’s Encrypt

If you use Nginx, ensure WebSocket upgrade headers are enabled.

## 7) Wire your app to LiveKit

On your API server (this repo):

In `server/apps/api/.env`:

```env
LIVEKIT_URL=wss://livekit.yourdomain.com
LIVEKIT_API_KEY=LKxxxxxxxx
LIVEKIT_API_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
```

On your client:

In `client/.env`:

```env
VITE_USE_LIVEKIT=1
```

Restart both servers after env changes.

## 8) (Optional) Using your existing TURN server

If you already run `turn.upliftsolutions.com.np`, you have two paths:

1) **Prefer** LiveKit embedded TURN (simplest; integrated auth).
2) Keep your existing TURN for other parts of the app, but for LiveKit connectivity, embedded TURN is usually easier.

If you want to keep external TURN for LiveKit specifically, we should do it by-the-book using LiveKit’s supported config options for external ICE/TURN servers for your exact LiveKit version. Tell me:

- your TURN ports (3478/5349/443?), UDP/TCP/TLS
- credentials type (static vs REST auth)

and I’ll tailor the `livekit.yaml` accordingly.

## Test checklist

- `curl https://livekit.yourdomain.com` returns something (or at least connects through proxy)
- From your app:
  - Create/join meeting → “Join” on the LiveKit meeting page
  - Remote participant can see video/audio
- If corporate networks fail: enable TURN/TLS.

