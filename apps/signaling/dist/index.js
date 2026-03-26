"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const node_fs_1 = __importDefault(require("node:fs"));
const node_http_1 = __importDefault(require("node:http"));
const node_https_1 = __importDefault(require("node:https"));
const node_path_1 = __importDefault(require("node:path"));
const express_1 = __importDefault(require("express"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const socket_io_1 = require("socket.io");
const meetingSignaling_1 = require("./meetingSignaling");
function readTlsOptions() {
    const keyPath = process.env.HTTPS_KEY_PATH;
    const certPath = process.env.HTTPS_CERT_PATH;
    if (keyPath === undefined ||
        certPath === undefined ||
        keyPath.length === 0 ||
        certPath.length === 0) {
        return null;
    }
    const keyFile = node_path_1.default.isAbsolute(keyPath)
        ? keyPath
        : node_path_1.default.join(process.cwd(), keyPath);
    const certFile = node_path_1.default.isAbsolute(certPath)
        ? certPath
        : node_path_1.default.join(process.cwd(), certPath);
    if (!node_fs_1.default.existsSync(keyFile) || !node_fs_1.default.existsSync(certFile)) {
        console.warn("HTTPS_KEY_PATH / HTTPS_CERT_PATH set but file(s) missing; falling back to HTTP.");
        return null;
    }
    return {
        key: node_fs_1.default.readFileSync(keyFile),
        cert: node_fs_1.default.readFileSync(certFile),
    };
}
function getJwtSecret() {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length === 0) {
        throw new Error("JWT_SECRET is not set");
    }
    return secret;
}
const app = (0, express_1.default)();
const portEnv = process.env.PORT;
const port = portEnv !== undefined && portEnv.length > 0 ? Number.parseInt(portEnv, 10) : 4002;
if (Number.isNaN(port)) {
    throw new Error(`Invalid PORT: ${portEnv ?? ""}`);
}
const hostEnv = process.env.HOST;
const listenHost = hostEnv !== undefined && hostEnv.length > 0 ? hostEnv : "0.0.0.0";
app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
});
const tls = readTlsOptions();
const server = tls !== null ? node_https_1.default.createServer(tls, app) : node_http_1.default.createServer(app);
const scheme = tls !== null ? "https" : "http";
const io = new socket_io_1.Server(server, {
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
        const payload = jsonwebtoken_1.default.verify(token, getJwtSecret());
        const userId = typeof payload.sub === "string"
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
    }
    catch {
        next(new Error("Unauthorized"));
    }
});
(0, meetingSignaling_1.registerMeetingSignaling)(io);
server.listen(port, listenHost, () => {
    console.log(`Signaling listening on ${scheme}://${listenHost}:${port} (match this scheme with the video page URL)`);
});
//# sourceMappingURL=index.js.map