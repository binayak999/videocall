"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
require("./types/express-augmentation");
const node_fs_1 = __importDefault(require("node:fs"));
const node_https_1 = __importDefault(require("node:https"));
const node_path_1 = __importDefault(require("node:path"));
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const db_1 = require("@bandr/db");
const auth_1 = require("./routes/auth");
const meetings_1 = require("./routes/meetings");
/**
 * Resolve `apps/api/public` whether we run from `src/` (ts-node) or `dist/` (node),
 * and tolerate a monorepo cwd that is not `apps/api`.
 */
function resolveApiPublicDir() {
    const candidates = [
        node_path_1.default.join(__dirname, "..", "public"),
        node_path_1.default.join(process.cwd(), "public"),
        node_path_1.default.join(process.cwd(), "apps", "api", "public"),
    ];
    for (const dir of candidates) {
        if (node_fs_1.default.existsSync(node_path_1.default.join(dir, "index.html")) &&
            node_fs_1.default.existsSync(node_path_1.default.join(dir, "meeting.html"))) {
            return dir;
        }
    }
    throw new Error(`API static folder not found (need index.html + meeting.html). Tried:\n${candidates.join("\n")}`);
}
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
const app = (0, express_1.default)();
if (process.env.NODE_ENV === "production") {
    app.set("trust proxy", 1);
}
const publicPath = resolveApiPublicDir();
const portEnv = process.env.PORT;
const port = portEnv !== undefined && portEnv.length > 0 ? Number.parseInt(portEnv, 10) : 4001;
if (Number.isNaN(port)) {
    throw new Error(`Invalid PORT: ${portEnv ?? ""}`);
}
const hostEnv = process.env.HOST;
const listenHost = hostEnv !== undefined && hostEnv.length > 0 ? hostEnv : "0.0.0.0";
const isDev = process.env.NODE_ENV !== "production";
const cspScriptSrc = [
    "'self'",
    "'unsafe-inline'",
    "https://cdn.socket.io",
    "https://cdn.tailwindcss.com",
];
// COOP is ignored (and browsers console-warn) on non-secure origins like http://192.168.x.x.
// We omit the header entirely so dev/LAN HTTP stays quiet; re-enable behind HTTPS if you need isolation.
const crossOriginOpenerPolicy = false;
app.use(isDev
    ? (0, helmet_1.default)({
        crossOriginOpenerPolicy,
        strictTransportSecurity: false,
        contentSecurityPolicy: {
            useDefaults: true,
            directives: {
                scriptSrc: cspScriptSrc,
                connectSrc: ["'self'", "http:", "https:", "ws:", "wss:"],
                // Default Helmet CSP includes upgrade-insecure-requests → browser fetches
                // https://<lan-ip>:4001/*.css over TLS; our server is HTTP-only → ERR_SSL_PROTOCOL_ERROR.
                upgradeInsecureRequests: null,
            },
        },
    })
    : (0, helmet_1.default)({
        crossOriginOpenerPolicy,
        contentSecurityPolicy: {
            useDefaults: true,
            directives: {
                scriptSrc: cspScriptSrc,
                connectSrc: ["'self'", "https:", "wss:", "http:", "ws:"],
            },
        },
    }));
app.use((0, cors_1.default)({
    origin: true,
    credentials: true,
}));
app.use(express_1.default.static(publicPath, { fallthrough: true }));
app.use(express_1.default.json({ limit: "1mb" }));
const apiLimiter = (0, express_rate_limit_1.default)({
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
    const requestHealth = async (base) => {
        const healthUrl = `${base}/health`;
        const url = new URL(healthUrl);
        const isTls = url.protocol === "https:";
        if (!isTls) {
            const r = await fetch(healthUrl);
            const text = await r.text();
            return { ok: r.ok, status: r.status, text };
        }
        return await new Promise((resolve, reject) => {
            const req = node_https_1.default.request({
                hostname: url.hostname,
                port: url.port.length > 0 ? Number.parseInt(url.port, 10) : 443,
                path: `${url.pathname}${url.search}`,
                method: "GET",
                rejectUnauthorized: false,
            }, (r) => {
                let body = "";
                r.setEncoding("utf8");
                r.on("data", (chunk) => {
                    body += chunk;
                });
                r.on("end", () => {
                    resolve({
                        ok: (r.statusCode ?? 500) >= 200 && (r.statusCode ?? 500) < 300,
                        status: r.statusCode ?? 500,
                        text: body,
                    });
                });
            });
            req.on("error", reject);
            req.end();
        });
    };
    const explicitBase = process.env.SIGNALING_URL !== undefined && process.env.SIGNALING_URL.length > 0
        ? process.env.SIGNALING_URL.replace(/\/$/, "")
        : null;
    const candidates = explicitBase !== null
        ? [explicitBase]
        : ["http://127.0.0.1:4002", "https://127.0.0.1:4002"];
    let lastError = null;
    for (const base of candidates) {
        try {
            const r = await requestHealth(base);
            const text = r.text;
            let body = text;
            if (text.length > 0) {
                try {
                    body = JSON.parse(text);
                }
                catch {
                    body = { raw: text };
                }
            }
            if (!r.ok) {
                lastError = { status: r.status, body };
                continue;
            }
            res.json(body);
            return;
        }
        catch (err) {
            lastError = err;
        }
    }
    if (typeof lastError === "object" &&
        lastError !== null &&
        "status" in lastError &&
        typeof lastError.status === "number") {
        const errorWithStatus = lastError;
        res
            .status(502)
            .json({ status: "error", upstreamStatus: errorWithStatus.status, body: errorWithStatus.body });
        return;
    }
    const message = lastError instanceof Error ? lastError.message : "unable to reach signaling health endpoint";
    res.status(502).json({ status: "error", detail: message });
});
app.use("/api/auth", auth_1.authRouter);
app.use("/api/meetings", meetings_1.meetingsRouter);
app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
});
async function main() {
    await db_1.prisma.$connect();
    const tls = readTlsOptions();
    const scheme = tls !== null ? "https" : "http";
    const onListen = () => {
        console.log(`API static files from ${publicPath}`);
        console.log(`API listening on ${scheme}://${listenHost}:${port} — camera/mic on LAN needs HTTPS (see HTTPS_KEY_PATH in apps/api/.env + mkcert).`);
    };
    if (tls !== null) {
        node_https_1.default.createServer(tls, app).listen(port, listenHost, onListen);
    }
    else {
        app.listen(port, listenHost, onListen);
    }
}
void main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map