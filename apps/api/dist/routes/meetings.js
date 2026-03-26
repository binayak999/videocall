"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.meetingsRouter = void 0;
const express_1 = require("express");
const nanoid_1 = require("nanoid");
const db_1 = require("@bandr/db");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
exports.meetingsRouter = router;
async function generateUniqueMeetingCode() {
    for (let attempt = 0; attempt < 12; attempt += 1) {
        const code = (0, nanoid_1.nanoid)(10);
        const existing = await db_1.prisma.meeting.findUnique({
            where: { code },
            select: { id: true },
        });
        if (!existing) {
            return code;
        }
    }
    throw new Error("Could not allocate a unique meeting code");
}
router.post("/", auth_1.authMiddleware, async (req, res) => {
    const userId = req.userId;
    if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    try {
        const body = req.body;
        const title = typeof body.title === "string" && body.title.trim().length > 0
            ? body.title.trim()
            : null;
        const code = await generateUniqueMeetingCode();
        const meeting = await db_1.prisma.meeting.create({
            data: {
                code,
                hostId: userId,
                title,
            },
            include: {
                host: {
                    select: { id: true, name: true, email: true },
                },
            },
        });
        res.status(201).json({ meeting });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Internal server error" });
    }
});
router.get("/:code", async (req, res) => {
    const { code } = req.params;
    if (!code || code.trim().length === 0) {
        res.status(400).json({ error: "Invalid code" });
        return;
    }
    try {
        const meeting = await db_1.prisma.meeting.findUnique({
            where: { code: code.trim() },
            include: {
                host: {
                    select: { id: true, name: true, email: true },
                },
            },
        });
        if (!meeting) {
            res.status(404).json({ error: "Meeting not found" });
            return;
        }
        res.json({ meeting });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Internal server error" });
    }
});
//# sourceMappingURL=meetings.js.map