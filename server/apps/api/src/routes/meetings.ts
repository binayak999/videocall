import { Router } from "express";
import { nanoid } from "nanoid";
import { prisma } from "@bandr/db";
import { authMiddleware } from "../middleware/auth";

const router = Router();

async function generateUniqueMeetingCode(): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = nanoid(10);
    const existing = await prisma.meeting.findUnique({
      where: { code },
      select: { id: true },
    });
    if (!existing) {
      return code;
    }
  }
  throw new Error("Could not allocate a unique meeting code");
}

router.post("/", authMiddleware, async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const body = req.body as { title?: unknown };
    const title =
      typeof body.title === "string" && body.title.trim().length > 0
        ? body.title.trim()
        : null;

    const code = await generateUniqueMeetingCode();

    const meeting = await prisma.meeting.create({
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
  } catch (err: unknown) {
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
    const meeting = await prisma.meeting.findUnique({
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
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export { router as meetingsRouter };
