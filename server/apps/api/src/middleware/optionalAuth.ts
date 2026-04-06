import type { RequestHandler } from "express";
import jwt from "jsonwebtoken";

function getJwtSecret(): string | undefined {
  const secret = process.env.JWT_SECRET;
  return secret && secret.length > 0 ? secret : undefined;
}

/** Sets `req.userId` when a valid Bearer JWT is present; otherwise continues without error. */
export const optionalAuthMiddleware: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    next();
    return;
  }

  const token = header.slice("Bearer ".length).trim();
  if (token.length === 0) {
    next();
    return;
  }

  const secret = getJwtSecret();
  if (!secret) {
    next();
    return;
  }

  try {
    const payload = jwt.verify(token, secret) as jwt.JwtPayload;
    const userId =
      typeof payload.sub === "string"
        ? payload.sub
        : typeof payload.userId === "string"
          ? payload.userId
          : undefined;
    if (userId) req.userId = userId;
  } catch {
    // ignore invalid/expired token
  }
  next();
};
