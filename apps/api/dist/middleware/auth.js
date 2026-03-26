"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authMiddleware = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
function getJwtSecret() {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length === 0) {
        throw new Error("JWT_SECRET is not set");
    }
    return secret;
}
const authMiddleware = (req, res, next) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
        res.status(401).json({ error: "Missing or invalid Authorization header" });
        return;
    }
    const token = header.slice("Bearer ".length).trim();
    if (token.length === 0) {
        res.status(401).json({ error: "Missing token" });
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
            res.status(401).json({ error: "Invalid token payload" });
            return;
        }
        req.userId = userId;
        next();
    }
    catch {
        res.status(401).json({ error: "Invalid or expired token" });
    }
};
exports.authMiddleware = authMiddleware;
//# sourceMappingURL=auth.js.map