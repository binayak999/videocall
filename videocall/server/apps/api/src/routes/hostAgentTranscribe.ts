import type { Request, Response } from "express";
import { prisma } from "@bandr/db";
import {
  isHostAgentSttNotConfiguredHfError,
  transcribeHostAgentAudio,
} from "../hostAgent/hfSpeechToText";

function meetingCodeParam(raw: string | string[] | undefined): string {
  if (typeof raw === "string") {
    return raw.trim();
  }
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === "string") {
    return raw[0].trim();
  }
  return "";
}

const MAX_AUDIO_BYTES = 24 * 1024 * 1024

export async function hostAgentTranscribeHandler(req: Request, res: Response): Promise<void> {
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

  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    res.status(400).json({ error: "Expected raw audio body" });
    return;
  }
  if (buf.length > MAX_AUDIO_BYTES) {
    res.status(413).json({ error: `Audio too large (max ${MAX_AUDIO_BYTES} bytes)` });
    return;
  }

  const rawCt = req.headers["content-type"];
  const contentType = typeof rawCt === "string" && rawCt.length > 0 ? rawCt : "application/octet-stream";

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
      res.status(403).json({ error: "Only the meeting host can use host agent transcription" });
      return;
    }

    try {
      const { text, provider } = await transcribeHostAgentAudio(buf, contentType);
      res.json({ text, provider });
    } catch (e: unknown) {
      const detail = e instanceof Error ? e.message : "Transcription failed";
      if (isHostAgentSttNotConfiguredHfError(e)) {
        res.status(503).json({
          error: "Host agent speech-to-text is not configured",
          detail:
            "Set HUGGINGFACE_API_TOKEN (or HF_TOKEN) for Hugging Face Whisper, or HOST_AGENT_STT_PROVIDER=openai with OPENAI_API_KEY. See apps/api/.env.example.",
        });
        return;
      }
      console.error("host-agent transcribe:", e);
      res.status(502).json({ error: "Transcription failed", detail });
    }
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
}
