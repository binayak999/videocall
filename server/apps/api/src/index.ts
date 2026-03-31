import "dotenv/config";
import "./types/express-augmentation";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { prisma } from "@bandr/db";
import { buildApiManifest, buildOpenApi } from "./apiDiscovery";
import { authRouter } from "./routes/auth";
import { authMiddleware } from "./middleware/auth";
import { meetingRecordingUploadHandler } from "./routes/meetingRecordingUpload";
import { meetingsRouter } from "./routes/meetings";
import { recordingsListRouter } from "./routes/recordings";
import { translateRouter } from "./routes/translate";

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
app.set("trust proxy", 1);
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
const cspScriptSrc = [
  "'self'",
  "'unsafe-inline'",
  "https://cdn.socket.io",
  "https://cdn.tailwindcss.com",
  "https://www.google.com",
  "https://www.gstatic.com",
  "https://accounts.google.com",
];
const cspFrameSrc = ["'self'", "https://accounts.google.com"];
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
            scriptSrc: cspScriptSrc,
            frameSrc: cspFrameSrc,
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
            scriptSrc: cspScriptSrc,
            frameSrc: cspFrameSrc,
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

// Recording upload: raw body, must run before express.json (browser → API → R2; avoids R2 CORS on presigned PUT).
// `type` must accept any Content-Type (e.g. video/webm;codecs=vp9,opus) — string "*/*" does not match those in type-is.
app.post(
  "/api/meetings/:code/recordings/upload",
  express.raw({ type: () => true, limit: "512mb" }),
  authMiddleware,
  meetingRecordingUploadHandler,
);

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
  const requestHealth = async (
    base: string,
  ): Promise<{ ok: boolean; status: number; text: string }> => {
    const healthUrl = `${base}/health`;
    const url = new URL(healthUrl);
    const isTls = url.protocol === "https:";
    if (!isTls) {
      const r = await fetch(healthUrl);
      const text = await r.text();
      return { ok: r.ok, status: r.status, text };
    }

    return await new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: url.hostname,
          port: url.port.length > 0 ? Number.parseInt(url.port, 10) : 443,
          path: `${url.pathname}${url.search}`,
          method: "GET",
          rejectUnauthorized: false,
        },
        (r) => {
          let body = "";
          r.setEncoding("utf8");
          r.on("data", (chunk: string) => {
            body += chunk;
          });
          r.on("end", () => {
            resolve({
              ok: (r.statusCode ?? 500) >= 200 && (r.statusCode ?? 500) < 300,
              status: r.statusCode ?? 500,
              text: body,
            });
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  };

  const explicitBase =
    process.env.SIGNALING_URL !== undefined && process.env.SIGNALING_URL.length > 0
      ? process.env.SIGNALING_URL.replace(/\/$/, "")
      : null;
  const candidates =
    explicitBase !== null
      ? [explicitBase]
      : ["http://127.0.0.1:4002", "https://127.0.0.1:4002"];

  let lastError: unknown = null;
  for (const base of candidates) {
    try {
      const r = await requestHealth(base);
      const text = r.text;
      let body: unknown = text;
      if (text.length > 0) {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          body = { raw: text };
        }
      }
      if (!r.ok) {
        lastError = { status: r.status, body };
        continue;
      }
      res.json(body);
      return;
    } catch (err: unknown) {
      lastError = err;
    }
  }

  if (
    typeof lastError === "object" &&
    lastError !== null &&
    "status" in lastError &&
    typeof (lastError as { status: unknown }).status === "number"
  ) {
    const errorWithStatus = lastError as { status: number; body?: unknown };
    res
      .status(502)
      .json({ status: "error", upstreamStatus: errorWithStatus.status, body: errorWithStatus.body });
    return;
  }

  const message =
    lastError instanceof Error ? lastError.message : "unable to reach signaling health endpoint";
  res.status(502).json({ status: "error", detail: message });
});

app.get("/api/turn-credentials", authMiddleware, (_req, res) => {
  const secret = process.env.TURN_SECRET?.trim();
  const host = process.env.TURN_HOST?.trim();
  if (!secret || !host) {
    res.status(500).json({ error: "TURN_SECRET or TURN_HOST is not configured" });
    return;
  }

  const ttlSeconds = 24 * 60 * 60;
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const username = `${expiresAt}`;
  const credential = createHmac("sha1", secret).update(username).digest("base64");
  const hostNoScheme = host.replace(/^turns?:\/\//i, "").replace(/\/+$/, "");

  res.json({
    iceServers: [
      { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
      {
        urls: [
          `turn:${hostNoScheme}:3478?transport=udp`,
          `turn:${hostNoScheme}:3478?transport=tcp`,
          `turns:${hostNoScheme}:5349?transport=tcp`,
        ],
        username,
        credential,
      },
    ],
  });
});

app.get("/api", (req, res) => {
  res.json(buildApiManifest(req));
});

app.get("/api/openapi.json", (req, res) => {
  res.json(buildOpenApi(req));
});

app.use("/api/auth", authRouter);
app.use("/api/meetings", meetingsRouter);
app.use("/api/translate", translateRouter);
app.use("/api/recordings", recordingsListRouter);

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
