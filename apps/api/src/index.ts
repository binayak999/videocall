import "dotenv/config";
import "./types/express-augmentation";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { prisma } from "@bandr/db";
import { authRouter } from "./routes/auth";
import { meetingsRouter } from "./routes/meetings";

/**
 * Resolve `apps/api/public` whether we run from `src/` (ts-node) or `dist/` (node),
 * and tolerate a monorepo cwd that is not `apps/api`.
 */
function resolveApiPublicDir(): string {
  const candidates = [
    path.join(__dirname, "..", "public"),
    path.join(process.cwd(), "public"),
    path.join(process.cwd(), "apps", "api", "public"),
  ];
  for (const dir of candidates) {
    if (
      fs.existsSync(path.join(dir, "index.html")) &&
      fs.existsSync(path.join(dir, "meeting.html"))
    ) {
      return dir;
    }
  }
  throw new Error(
    `API static folder not found (need index.html + meeting.html). Tried:\n${candidates.join("\n")}`,
  );
}

function readTlsOptions(): https.ServerOptions | null {
  const keyPath = process.env.HTTPS_KEY_PATH;
  const certPath = process.env.HTTPS_CERT_PATH;
  if (
    keyPath === undefined ||
    certPath === undefined ||
    keyPath.length === 0 ||
    certPath.length === 0
  ) {
    return null;
  }
  const keyFile = path.isAbsolute(keyPath)
    ? keyPath
    : path.join(process.cwd(), keyPath);
  const certFile = path.isAbsolute(certPath)
    ? certPath
    : path.join(process.cwd(), certPath);
  if (!fs.existsSync(keyFile) || !fs.existsSync(certFile)) {
    console.warn(
      "HTTPS_KEY_PATH / HTTPS_CERT_PATH set but file(s) missing; falling back to HTTP.",
    );
    return null;
  }
  return {
    key: fs.readFileSync(keyFile),
    cert: fs.readFileSync(certFile),
  };
}

const app = express();
if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}
const publicPath = resolveApiPublicDir();

const portEnv = process.env.PORT;
const port =
  portEnv !== undefined && portEnv.length > 0 ? Number.parseInt(portEnv, 10) : 4001;
if (Number.isNaN(port)) {
  throw new Error(`Invalid PORT: ${portEnv ?? ""}`);
}

const hostEnv = process.env.HOST;
const listenHost =
  hostEnv !== undefined && hostEnv.length > 0 ? hostEnv : "0.0.0.0";

const isDev = process.env.NODE_ENV !== "production";
// COOP is ignored (and browsers console-warn) on non-secure origins like http://192.168.x.x.
// We omit the header entirely so dev/LAN HTTP stays quiet; re-enable behind HTTPS if you need isolation.
const crossOriginOpenerPolicy = false;
app.use(
  isDev
    ? helmet({
        crossOriginOpenerPolicy,
        strictTransportSecurity: false,
        contentSecurityPolicy: {
          useDefaults: true,
          directives: {
            scriptSrc: ["'self'", "https://cdn.socket.io"],
            connectSrc: ["'self'", "http:", "https:", "ws:", "wss:"],
            // Default Helmet CSP includes upgrade-insecure-requests → browser fetches
            // https://<lan-ip>:4001/*.css over TLS; our server is HTTP-only → ERR_SSL_PROTOCOL_ERROR.
            upgradeInsecureRequests: null,
          },
        },
      })
    : helmet({
        crossOriginOpenerPolicy,
        contentSecurityPolicy: {
          useDefaults: true,
          directives: {
            scriptSrc: ["'self'", "https://cdn.socket.io"],
            connectSrc: ["'self'", "https:", "wss:", "http:", "ws:"],
          },
        },
      }),
);
app.use(
  cors({
    origin: true,
    credentials: true,
  }),
);

app.use(express.static(publicPath, { fallthrough: true }));

app.use(express.json({ limit: "1mb" }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/api", apiLimiter);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/signaling-health", async (_req, res) => {
  const base = (process.env.SIGNALING_URL ?? "http://127.0.0.1:4002").replace(
    /\/$/,
    "",
  );
  try {
    const r = await fetch(`${base}/health`);
    const text = await r.text();
    let body: unknown = text;
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = { raw: text };
      }
    }
    if (!r.ok) {
      res.status(502).json({ status: "error", upstreamStatus: r.status, body });
      return;
    }
    res.json(body);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "unknown error";
    res.status(502).json({ status: "error", detail: message });
  }
});

app.use("/api/auth", authRouter);
app.use("/api/meetings", meetingsRouter);

app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  },
);

async function main(): Promise<void> {
  await prisma.$connect();
  const tls = readTlsOptions();
  const scheme = tls !== null ? "https" : "http";
  const onListen = (): void => {
    console.log(`API static files from ${publicPath}`);
    console.log(
      `API listening on ${scheme}://${listenHost}:${port} — camera/mic on LAN needs HTTPS (see HTTPS_KEY_PATH in apps/api/.env + mkcert).`,
    );
  };
  if (tls !== null) {
    https.createServer(tls, app).listen(port, listenHost, onListen);
  } else {
    app.listen(port, listenHost, onListen);
  }
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
