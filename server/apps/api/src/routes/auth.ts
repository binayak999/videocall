import { Router } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { Prisma, prisma } from "@bandr/db";

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

router.post("/register", async (req, res) => {
  const body = req.body as {
    email?: unknown;
    password?: unknown;
    name?: unknown;
  };

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
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
      },
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
  const body = req.body as { email?: unknown; password?: unknown };

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

export { router as authRouter };
