import { Router } from "express";
import { prisma } from "@bandr/db";
import { authMiddleware } from "../middleware/auth";
import { optionalAuthMiddleware } from "../middleware/optionalAuth";
import { isSuperadminEmail } from "../lib/superadmin";

const router = Router();

const RTC_MODE_KEY = "rtc_mode";

export type RtcMode = "mesh" | "livekit";

function defaultRtcModeFromEnv(): RtcMode {
  const v = (process.env.USE_LIVEKIT ?? "").trim().toLowerCase();
  return v === "1" || v === "true" ? "livekit" : "mesh";
}

function parseRtcMode(raw: string | null | undefined): RtcMode | null {
  if (raw === "mesh" || raw === "livekit") return raw;
  return null;
}

async function getStoredRtcMode(): Promise<RtcMode | null> {
  const row = await prisma.systemSetting.findUnique({
    where: { key: RTC_MODE_KEY },
    select: { value: true },
  });
  return parseRtcMode(row?.value);
}

export async function resolvedSystemRtcMode(): Promise<RtcMode> {
  const stored = await getStoredRtcMode();
  return stored ?? defaultRtcModeFromEnv();
}

router.get("/rtc-mode", optionalAuthMiddleware, async (req, res) => {
  try {
    const row = await prisma.systemSetting.findUnique({
      where: { key: RTC_MODE_KEY },
      select: { value: true },
    });
    const persisted = parseRtcMode(row?.value) !== null;
    const rtcMode = await resolvedSystemRtcMode();
    let canControl = false;
    if (typeof req.userId === "string" && req.userId.length > 0) {
      const user = await prisma.user.findUnique({
        where: { id: req.userId },
        select: { email: true },
      });
      canControl = isSuperadminEmail(user?.email);
    }
    res.json({ rtcMode, canControl, persisted });
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/rtc-mode", authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { email: true },
    });
    if (!isSuperadminEmail(user?.email)) {
      res.status(403).json({ error: "Only super administrators can change system RTC mode" });
      return;
    }

    const body = req.body as { rtcMode?: unknown };
    const mode = body.rtcMode;
    if (mode !== "mesh" && mode !== "livekit") {
      res.status(400).json({ error: "rtcMode must be mesh or livekit" });
      return;
    }

    await prisma.systemSetting.upsert({
      where: { key: RTC_MODE_KEY },
      create: { key: RTC_MODE_KEY, value: mode },
      update: { value: mode },
    });

    res.json({ rtcMode: mode, persisted: true });
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export { router as systemRtcModeRouter };
