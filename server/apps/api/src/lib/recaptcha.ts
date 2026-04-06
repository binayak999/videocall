import type { Request } from "express";

type SiteVerifyResponse = {
  success: boolean;
  score?: number;
  action?: string;
  "error-codes"?: string[];
};

function clientIp(req: Request): string | undefined {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length > 0) {
    const first = xf.split(",")[0]?.trim();
    if (first && first.length > 0) return first;
  }
  if (typeof req.socket?.remoteAddress === "string" && req.socket.remoteAddress.length > 0) {
    return req.socket.remoteAddress;
  }
  return undefined;
}

/**
 * Verifies reCAPTCHA v3 token server-side.
 * If RECAPTCHA_SECRET_KEY is unset, skips verification (local dev).
 */
export async function verifyRecaptchaV3(
  req: Request,
  token: string | undefined,
  expectedAction: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const secret = process.env.RECAPTCHA_SECRET_KEY?.trim();
  if (!secret) {
    return { ok: true };
  }

  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, status: 400, error: "reCAPTCHA token required" };
  }

  const params = new URLSearchParams();
  params.set("secret", secret);
  params.set("response", token);
  const ip = clientIp(req);
  if (ip) params.set("remoteip", ip);

  let data: SiteVerifyResponse;
  try {
    const r = await fetch("https://www.google.com/recaptcha/api/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    data = (await r.json()) as SiteVerifyResponse;
  } catch {
    return { ok: false, status: 502, error: "reCAPTCHA verification unavailable" };
  }

  if (!data.success) {
    return { ok: false, status: 400, error: "reCAPTCHA verification failed" };
  }

  const minRaw = process.env.RECAPTCHA_MIN_SCORE?.trim();
  const minScore =
    minRaw !== undefined && minRaw.length > 0 ? Number.parseFloat(minRaw) : 0.5;
  if (Number.isFinite(minScore) && typeof data.score === "number" && data.score < minScore) {
    return { ok: false, status: 403, error: "reCAPTCHA score too low" };
  }

  if (typeof data.action === "string" && data.action.length > 0 && data.action !== expectedAction) {
    return { ok: false, status: 400, error: "reCAPTCHA action mismatch" };
  }

  return { ok: true };
}
