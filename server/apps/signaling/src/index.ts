import { config as loadEnv } from "dotenv";
import { createServer } from "node:http";
import path from "node:path";
import jwt from "jsonwebtoken";
import { prisma } from "@bandr/db";
import { Server, type Socket } from "socket.io";

loadEnv({ path: path.resolve(process.cwd(), "..", "api", ".env") });
loadEnv();

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length === 0) {
    throw new Error("JWT_SECRET is not set");
  }
  return secret;
}

interface MeetingSocketData {
  userId: string;
  meetingRoom?: string;
}

const portEnv = process.env.PORT;
const port =
  portEnv !== undefined && portEnv.length > 0 ? Number.parseInt(portEnv, 10) : 4002;
if (Number.isNaN(port)) {
  throw new Error(`Invalid PORT: ${portEnv ?? ""}`);
}

const hostEnv = process.env.HOST;
const listenHost =
  hostEnv !== undefined && hostEnv.length > 0 ? hostEnv : "0.0.0.0";

const httpServer = createServer((req, res) => {
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const io = new Server(httpServer, {
  cors: { origin: true, credentials: true },
});

function targetSharesRoom(sender: Socket, targetId: string): boolean {
  const room = sender.data.meetingRoom as string | undefined;
  if (!room) return false;
  const target = io.sockets.sockets.get(targetId);
  return target?.rooms.has(room) ?? false;
}

function leaveMeeting(socket: Socket): void {
  const room = socket.data.meetingRoom as string | undefined;
  if (!room) return;
  void socket.leave(room);
  socket.data.meetingRoom = undefined;
  socket.to(room).emit("meeting:peer-left", { peerId: socket.id });
}

io.use((socket, next) => {
  const raw = socket.handshake.auth as { token?: unknown };
  const token = typeof raw.token === "string" ? raw.token.trim() : "";
  if (token.length === 0) {
    next(new Error("Unauthorized"));
    return;
  }
  try {
    const payload = jwt.verify(token, getJwtSecret()) as jwt.JwtPayload;
    const userId =
      typeof payload.sub === "string"
        ? payload.sub
        : typeof payload.userId === "string"
          ? payload.userId
          : undefined;
    if (!userId) {
      next(new Error("Unauthorized"));
      return;
    }
    (socket.data as MeetingSocketData).userId = userId;
    next();
  } catch {
    next(new Error("Unauthorized"));
  }
});

io.on("connection", (socket) => {
  socket.on("disconnecting", () => {
    leaveMeeting(socket);
  });

  socket.on("meeting:leave", () => {
    leaveMeeting(socket);
  });

  socket.on("meeting:join", async (code: unknown, cb: unknown) => {
    if (typeof cb !== "function") return;
    const ack = cb as (v: Record<string, unknown>) => void;

    if (typeof code !== "string" || code.trim().length === 0) {
      ack({ ok: false, error: "Invalid meeting code" });
      return;
    }

    const trimmed = code.trim();
    let meeting: { hostId: string } | null;
    try {
      meeting = await prisma.meeting.findUnique({
        where: { code: trimmed },
        select: { hostId: true },
      });
    } catch (err) {
      console.error(err);
      ack({ ok: false, error: "Database error" });
      return;
    }

    if (!meeting) {
      ack({ ok: false, error: "Meeting not found" });
      return;
    }

    leaveMeeting(socket);

    const room = `meeting:${trimmed}`;
    let existingIds: string[];
    try {
      const existing = await io.in(room).fetchSockets();
      existingIds = existing.map((s) => s.id);
    } catch (err) {
      console.error(err);
      ack({ ok: false, error: "Could not join room" });
      return;
    }

    await socket.join(room);
    (socket.data as MeetingSocketData).meetingRoom = room;

    socket.to(room).emit("meeting:peer-joined", { peerId: socket.id });

    const userId = (socket.data as MeetingSocketData).userId;
    ack({
      ok: true,
      room: trimmed,
      isHost: meeting.hostId === userId,
      peerCount: existingIds.length + 1,
      peerIds: existingIds,
    });
  });

  socket.on("webrtc:offer", (msg: unknown) => {
    if (!msg || typeof msg !== "object") return;
    const m = msg as { to?: unknown; sdp?: unknown };
    if (typeof m.to !== "string" || !m.sdp || typeof m.sdp !== "object") return;
    if (!targetSharesRoom(socket, m.to)) return;
    io.to(m.to).emit("webrtc:offer", { from: socket.id, sdp: m.sdp });
  });

  socket.on("webrtc:answer", (msg: unknown) => {
    if (!msg || typeof msg !== "object") return;
    const m = msg as { to?: unknown; sdp?: unknown };
    if (typeof m.to !== "string" || !m.sdp || typeof m.sdp !== "object") return;
    if (!targetSharesRoom(socket, m.to)) return;
    io.to(m.to).emit("webrtc:answer", { from: socket.id, sdp: m.sdp });
  });

  socket.on("webrtc:ice", (msg: unknown) => {
    if (!msg || typeof msg !== "object") return;
    const m = msg as { to?: unknown; candidate?: unknown };
    if (typeof m.to !== "string" || !m.candidate || typeof m.candidate !== "object")
      return;
    if (!targetSharesRoom(socket, m.to)) return;
    io.to(m.to).emit("webrtc:ice", {
      from: socket.id,
      candidate: m.candidate,
    });
  });
});

async function main(): Promise<void> {
  await prisma.$connect();
  httpServer.listen(port, listenHost, () => {
    console.log(
      `Signaling (Socket.IO) on http://${listenHost}:${port} — same JWT_SECRET as API`,
    );
  });
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
