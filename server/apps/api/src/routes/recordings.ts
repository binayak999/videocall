import { Router } from "express";
import { prisma } from "@bandr/db";
import { authMiddleware } from "../middleware/auth";
import { presignedGetRecording, publicRecordingUrl } from "../meetingRecordingR2";

const router = Router();

router.get("/", authMiddleware, async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const rows = await prisma.meetingRecording.findMany({
      where: { hostId: userId },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        meeting: { select: { code: true, title: true } },
      },
    });

    const recordings = await Promise.all(
      rows.map(async (r) => {
        const publicUrl = publicRecordingUrl(r.r2Key);
        const playbackUrl =
          publicUrl ?? (await presignedGetRecording(r.r2Key, 3600));
        return {
          id: r.id,
          meetingId: r.meetingId,
          meetingCode: r.meeting.code,
          meetingTitle: r.meeting.title,
          mimeType: r.mimeType,
          durationSec: r.durationSec,
          sizeBytes: r.sizeBytes,
          createdAt: r.createdAt.toISOString(),
          playbackUrl,
        };
      }),
    );

    res.json({ recordings });
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export { router as recordingsListRouter };
