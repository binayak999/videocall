"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authRouter = void 0;
const express_1 = require("express");
const bcrypt_1 = __importDefault(require("bcrypt"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const db_1 = require("@bandr/db");
const router = (0, express_1.Router)();
exports.authRouter = router;
const BCRYPT_ROUNDS = 10;
function getJwtSecret() {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length === 0) {
        throw new Error("JWT_SECRET is not set");
    }
    return secret;
}
function signToken(userId) {
    return jsonwebtoken_1.default.sign({ sub: userId }, getJwtSecret(), { expiresIn: "7d" });
}
router.post("/register", async (req, res) => {
    const body = req.body;
    if (typeof body.email !== "string" ||
        typeof body.password !== "string" ||
        typeof body.name !== "string") {
        res.status(400).json({ error: "email, password, and name are required" });
        return;
    }
    const email = body.email.trim().toLowerCase();
    const password = body.password;
    const name = body.name.trim();
    if (email.length === 0 || !email.includes("@")) {
        res.status(400).json({ error: "Invalid email" });
        return;
    }
    if (password.length < 8) {
        res.status(400).json({ error: "Password must be at least 8 characters" });
        return;
    }
    if (name.length === 0) {
        res.status(400).json({ error: "Invalid name" });
        return;
    }
    const passwordHash = await bcrypt_1.default.hash(password, BCRYPT_ROUNDS);
    try {
        const user = await db_1.prisma.user.create({
            data: {
                email,
                name,
                password: passwordHash,
                provider: "local",
            },
            select: {
                id: true,
                email: true,
                name: true,
                createdAt: true,
            },
        });
        const token = signToken(user.id);
        res.status(201).json({ token, user });
    }
    catch (err) {
        if (err instanceof db_1.Prisma.PrismaClientKnownRequestError) {
            if (err.code === "P2002") {
                res.status(409).json({ error: "Email already registered" });
                return;
            }
        }
        console.error(err);
        res.status(500).json({ error: "Internal server error" });
    }
});
router.post("/login", async (req, res) => {
    const body = req.body;
    if (typeof body.email !== "string" || typeof body.password !== "string") {
        res.status(400).json({ error: "email and password are required" });
        return;
    }
    try {
        const email = body.email.trim().toLowerCase();
        const user = await db_1.prisma.user.findUnique({ where: { email } });
        if (!user || !user.password) {
            res.status(401).json({ error: "Invalid credentials" });
            return;
        }
        const match = await bcrypt_1.default.compare(body.password, user.password);
        if (!match) {
            res.status(401).json({ error: "Invalid credentials" });
            return;
        }
        const token = signToken(user.id);
        res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                createdAt: user.createdAt,
            },
        });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Internal server error" });
    }
});
//# sourceMappingURL=auth.js.map