import type { RequestHandler } from "express";
import { prisma } from "@bandr/db";
import {
  buildRecordingObjectKey,
  normalizeRecordingContentType,
  putRecordingObject,
  r2FailureMessage,
} from "../meetingRecordingR2";

function meetingCodeParam(raw: string | string[] | undefined): string {
  if (typeof raw === "string") {
    return raw.trim();
  }
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === "string") {
    return raw[0].trim();
  }
  return "";
}

/**
 * Raw body upload (registered before express.json). Server writes to R2 — avoids browser CORS to R2.
 */
export const meetingRecordingUploadHandler: RequestHandler = async (req, res) => {
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

  const body = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0) {
    res.status(400).json({ error: "Expected non-empty recording body" });
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
      res.status(403).json({ error: "Only the meeting host can upload a recording" });
      return;
    }

    const rawCt = typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "video/webm";
    const contentType = normalizeRecordingContentType(rawCt);
    const key = buildRecordingObjectKey(meeting.id);

    try {
      await putRecordingObject(key, body, contentType);
    } catch (e: unknown) {
      console.error("R2 PutObject failed:", e);
      const detail = r2FailureMessage(e);
      res.status(502).json({
        error:
          "Could not store recording. Use the S3 API hostname (for Cloudflare R2: https://<ACCOUNT_ID>.r2.cloudflarestorage.com). Optional public CDN goes in R2_PUBLIC_BASE_URL for playback only.",
        detail,
      });
      return;
    }

    res.status(201).json({ key, contentType });
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
};
