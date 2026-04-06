import { Router } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { OAuth2Client, type TokenPayload } from "google-auth-library";
import { Prisma, prisma } from "@bandr/db";
import { verifyRecaptchaV3 } from "../lib/recaptcha";

const router = Router();

const BCRYPT_ROUNDS = 10;

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length === 0) {
    throw new Error("JWT_SECRET is not set");
  }
  return secret;
}

function signToken(user: { id: string; email: string; name: string }): string {
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.name },
    getJwtSecret(),
    { expiresIn: "7d" },
  );
}

const userAuthSelect = {
  id: true,
  email: true,
  name: true,
  createdAt: true,
} as const;

router.post("/register", async (req, res) => {
  const body = req.body as {
    email?: unknown;
    password?: unknown;
    name?: unknown;
    recaptchaToken?: unknown;
  };

  const cap = await verifyRecaptchaV3(
    req,
    typeof body.recaptchaToken === "string" ? body.recaptchaToken : undefined,
    "register",
  );
  if (!cap.ok) {
    res.status(cap.status).json({ error: cap.error });
    return;
  }

  if (
    typeof body.email !== "string" ||
    typeof body.password !== "string" ||
    typeof body.name !== "string"
  ) {
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

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  try {
    const user = await prisma.user.create({
      data: {
        email,
        name,
        password: passwordHash,
        provider: "local",
      },
      select: userAuthSelect,
    });

    const token = signToken({ id: user.id, email: user.email, name: user.name });
    res.status(201).json({ token, user });
  } catch (err: unknown) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
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
  const body = req.body as {
    email?: unknown;
    password?: unknown;
    recaptchaToken?: unknown;
  };

  const cap = await verifyRecaptchaV3(
    req,
    typeof body.recaptchaToken === "string" ? body.recaptchaToken : undefined,
    "login",
  );
  if (!cap.ok) {
    res.status(cap.status).json({ error: cap.error });
    return;
  }

  if (typeof body.email !== "string" || typeof body.password !== "string") {
    res.status(400).json({ error: "email and password are required" });
    return;
  }

  try {
    const email = body.email.trim().toLowerCase();
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user || !user.password) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const match = await bcrypt.compare(body.password, user.password);
    if (!match) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const token = signToken({
      id: user.id,
      email: user.email,
      name: user.name,
    });
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        createdAt: user.createdAt,
      },
    });
  } catch (err: unknown) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/google", async (req, res) => {
  const body = req.body as { idToken?: unknown; recaptchaToken?: unknown };

  const cap = await verifyRecaptchaV3(
    req,
    typeof body.recaptchaToken === "string" ? body.recaptchaToken : undefined,
    "google_login",
  );
  if (!cap.ok) {
    res.status(cap.status).json({ error: cap.error });
    return;
  }

  if (typeof body.idToken !== "string" || body.idToken.length === 0) {
    res.status(400).json({ error: "idToken is required" });
    return;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  if (!clientId) {
    res.status(503).json({ error: "Google sign-in is not configured" });
    return;
  }

  const oauth = new OAuth2Client(clientId);
  let payload: TokenPayload | undefined;
  try {
    const ticket = await oauth.verifyIdToken({
      idToken: body.idToken,
      audience: clientId,
    });
    payload = ticket.getPayload() ?? undefined;
  } catch {
    res.status(401).json({ error: "Invalid Google token" });
    return;
  }
  if (payload === undefined) {
    res.status(401).json({ error: "Invalid Google token" });
    return;
  }

  const emailRaw = payload.email;
  const sub = payload.sub;
  if (typeof emailRaw !== "string" || emailRaw.length === 0 || typeof sub !== "string" || sub.length === 0) {
    res.status(400).json({ error: "Google account has no email" });
    return;
  }

  const verified = payload.email_verified === true;
  if (!verified) {
    res.status(403).json({ error: "Google email is not verified" });
    return;
  }

  const email = emailRaw.trim().toLowerCase();
  const nameFromGoogle =
    typeof payload.name === "string" && payload.name.trim().length > 0
      ? payload.name.trim()
      : email.split("@")[0] ?? "User";

  try {
    let user = await prisma.user.findUnique({
      where: { googleSub: sub },
      select: userAuthSelect,
    });

    if (user === null) {
      const byEmail = await prisma.user.findUnique({ where: { email } });
      if (byEmail !== null) {
        if (byEmail.googleSub !== null && byEmail.googleSub !== sub) {
          res.status(409).json({ error: "This email is linked to a different Google account" });
          return;
        }
        user = await prisma.user.update({
          where: { id: byEmail.id },
          data: { googleSub: sub },
          select: userAuthSelect,
        });
      } else {
        user = await prisma.user.create({
          data: {
            email,
            name: nameFromGoogle,
            password: null,
            provider: "google",
            googleSub: sub,
          },
          select: userAuthSelect,
        });
      }
    }

    if (user === null) {
      res.status(500).json({ error: "Internal server error" });
      return;
    }

    const token = signToken({
      id: user.id,
      email: user.email,
      name: user.name,
    });
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        createdAt: user.createdAt,
      },
    });
  } catch (err: unknown) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === "P2002") {
        res.status(409).json({ error: "Account conflict" });
        return;
      }
    }
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export { router as authRouter };
