import { Router } from "express";
import { nanoid } from "nanoid";
import { prisma } from "@bandr/db";
import {
  buildRecordingObjectKey,
  isRecordingKeyForMeeting,
  normalizeRecordingContentType,
  presignedGetRecording,
  presignedPutRecording,
  publicRecordingUrl,
} from "../meetingRecordingR2";
import { authMiddleware } from "../middleware/auth";

const router = Router();

function meetingCodeParam(raw: string | string[] | undefined): string {
  if (typeof raw === "string") {
    return raw.trim();
  }
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === "string") {
    return raw[0].trim();
  }
  return "";
}

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

router.post("/:code/recordings/presign", authMiddleware, async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const code = meetingCodeParam(req.params.code);
  if (!code) {
    res.status(400).json({ error: "Invalid code" });
    return;
  }

  try {
    const meeting = await prisma.meeting.findUnique({
      where: { code },
      select: { id: true, hostId: true },
    });
    if (!meeting) {
      res.status(404).json({ error: "Meeting not found" });
      return;
    }
    if (meeting.hostId !== userId) {
      res.status(403).json({ error: "Only the meeting host can record" });
      return;
    }

    const body = req.body as { contentType?: unknown };
    const rawCt =
      typeof body.contentType === "string" && body.contentType.length > 0
        ? body.contentType
        : "video/webm";
    const contentType = normalizeRecordingContentType(rawCt);

    const key = buildRecordingObjectKey(meeting.id);
    let uploadUrl: string;
    try {
      uploadUrl = await presignedPutRecording(key, contentType);
    } catch (e: unknown) {
      console.error(e);
      res.status(503).json({
        error:
          "Recording storage is not configured. Set R2_ENDPOINT, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY.",
      });
      return;
    }

    res.json({
      uploadUrl,
      key,
      contentType,
      headers: { "Content-Type": contentType },
    });
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/:code/recordings/complete", authMiddleware, async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const code = meetingCodeParam(req.params.code);
  if (!code) {
    res.status(400).json({ error: "Invalid code" });
    return;
  }

  const body = req.body as {
    key?: unknown;
    sizeBytes?: unknown;
    durationSec?: unknown;
    mimeType?: unknown;
  };
  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (key.length === 0) {
    res.status(400).json({ error: "Missing key" });
    return;
  }

  try {
    const meeting = await prisma.meeting.findUnique({
      where: { code },
      select: { id: true, hostId: true },
    });
    if (!meeting) {
      res.status(404).json({ error: "Meeting not found" });
      return;
    }
    if (meeting.hostId !== userId) {
      res.status(403).json({ error: "Only the meeting host can complete a recording" });
      return;
    }
    if (!isRecordingKeyForMeeting(key, meeting.id)) {
      res.status(400).json({ error: "Invalid recording key" });
      return;
    }

    const sizeBytes =
      typeof body.sizeBytes === "number" && Number.isFinite(body.sizeBytes)
        ? Math.max(0, Math.floor(body.sizeBytes))
        : null;
    const durationSec =
      typeof body.durationSec === "number" && Number.isFinite(body.durationSec)
        ? Math.max(0, Math.floor(body.durationSec))
        : null;
    const mimeType =
      typeof body.mimeType === "string" && body.mimeType.length > 0
        ? body.mimeType
        : "video/webm";

    const rec = await prisma.meetingRecording.create({
      data: {
        meetingId: meeting.id,
        hostId: userId,
        r2Key: key,
        mimeType,
        sizeBytes,
        durationSec,
      },
      include: {
        meeting: { select: { code: true, title: true } },
      },
    });

    const publicUrl = publicRecordingUrl(rec.r2Key);
    const playbackUrl = publicUrl ?? (await presignedGetRecording(rec.r2Key, 3600));

    res.status(201).json({
      recording: {
        id: rec.id,
        meetingId: rec.meetingId,
        meetingCode: rec.meeting.code,
        meetingTitle: rec.meeting.title,
        mimeType: rec.mimeType,
        durationSec: rec.durationSec,
        sizeBytes: rec.sizeBytes,
        createdAt: rec.createdAt.toISOString(),
        playbackUrl,
      },
    });
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/:code", async (req, res) => {
  const code = meetingCodeParam(req.params.code);
  if (!code) {
    res.status(400).json({ error: "Invalid code" });
    return;
  }

  try {
    const meeting = await prisma.meeting.findUnique({
      where: { code },
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
