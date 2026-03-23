import "dotenv/config";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import express from "express";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import { registerMeetingSignaling } from "./meetingSignaling";

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

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length === 0) {
    throw new Error("JWT_SECRET is not set");
  }
  return secret;
}

const app = express();

const portEnv = process.env.PORT;
const port =
  portEnv !== undefined && portEnv.length > 0 ? Number.parseInt(portEnv, 10) : 4002;
if (Number.isNaN(port)) {
  throw new Error(`Invalid PORT: ${portEnv ?? ""}`);
}

const hostEnv = process.env.HOST;
const listenHost =
  hostEnv !== undefined && hostEnv.length > 0 ? hostEnv : "0.0.0.0";

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

const tls = readTlsOptions();
const server =
  tls !== null ? https.createServer(tls, app) : http.createServer(app);
const scheme = tls !== null ? "https" : "http";

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (typeof token !== "string" || token.length === 0) {
    next(new Error("Unauthorized"));
    return;
  }

  try {
    const payload = jwt.verify(token, getJwtSecret()) as jwt.JwtPayload;
    const userId =
      typeof payload.sub === "string"
        ? payload.sub
        : typeof payload.userId === "string"
          ? payload.userId
          : undefined;

    if (!userId) {
      next(new Error("Unauthorized"));
      return;
    }

    socket.data.userId = userId;
    next();
  } catch {
    next(new Error("Unauthorized"));
  }
});

registerMeetingSignaling(io);

server.listen(port, listenHost, () => {
  console.log(
    `Signaling listening on ${scheme}://${listenHost}:${port} (match this scheme with the video page URL)`,
  );
});
