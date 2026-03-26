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
  userName: string;
  meetingRoom?: string;
  meetingId?: string;
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
const CHAT_PAGE_SIZE = 50;
const roomWhiteboardState = new Map<string, boolean>();
const roomWhiteboardOwner = new Map<string, string>();
const roomWhiteboardEditors = new Map<string, Set<string>>();
const roomHostUserId = new Map<string, string>();
const roomPendingJoinIds = new Map<string, Set<string>>();
const pendingJoinBySocketId = new Map<
  string,
  { room: string; meetingId: string; code: string; requesterName: string; requesterUserId: string }
>();

function emitWhiteboardPermissions(room: string): void {
  const ownerId = roomWhiteboardOwner.get(room) ?? null;
  const editors = [...(roomWhiteboardEditors.get(room) ?? new Set<string>())];
  io.in(room).emit("meeting:whiteboard-permissions", { ownerId, editors });
}

function targetSharesRoom(sender: Socket, targetId: string): boolean {
  const room = sender.data.meetingRoom as string | undefined;
  if (!room) return false;
  const target = io.sockets.sockets.get(targetId);
  return target?.rooms.has(room) ?? false;
}

async function loadRecentChat(meetingId: string): Promise<{ chatHistory: {
  id: string;
  senderUserId: string;
  senderName: string;
  text: string;
  createdAt: string;
}[]; chatHasMore: boolean }> {
  let chatHistory: {
    id: string;
    senderUserId: string;
    senderName: string;
    text: string;
    createdAt: string;
  }[] = [];
  let chatHasMore = false;
  try {
    const rows = await prisma.chatMessage.findMany({
      where: { meetingId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: CHAT_PAGE_SIZE + 1,
      select: {
        id: true,
        senderUserId: true,
        senderName: true,
        text: true,
        createdAt: true,
      },
    });
    chatHasMore = rows.length > CHAT_PAGE_SIZE;
    const page = chatHasMore ? rows.slice(0, CHAT_PAGE_SIZE) : rows;
    chatHistory = page.reverse().map((m) => ({ ...m, createdAt: m.createdAt.toISOString() }));
  } catch (err) {
    console.error(err);
  }
  return { chatHistory, chatHasMore };
}

function clearPendingJoin(socketId: string): void {
  const pending = pendingJoinBySocketId.get(socketId);
  if (!pending) return;
  pendingJoinBySocketId.delete(socketId);
  const inRoom = roomPendingJoinIds.get(pending.room);
  if (!inRoom) return;
  inRoom.delete(socketId);
  if (inRoom.size === 0) roomPendingJoinIds.delete(pending.room);
}

function notifyHostOfPending(room: string, hostId: string): void {
  const pendingIds = [...(roomPendingJoinIds.get(room) ?? new Set<string>())];
  if (pendingIds.length === 0) return;
  const sockets = io.sockets.sockets;
  for (const sid of pendingIds) {
    const pending = pendingJoinBySocketId.get(sid);
    if (!pending) continue;
    const target = sockets.get(sid);
    if (!target) {
      clearPendingJoin(sid);
      continue;
    }
    io.to(hostId).emit("meeting:join-request", {
      requestId: sid,
      name: pending.requesterName,
      userId: pending.requesterUserId,
    });
  }
}

async function getHostPeerId(room: string): Promise<string | null> {
  const hostUserId = roomHostUserId.get(room);
  if (!hostUserId) return null;
  try {
    const sockets = await io.in(room).fetchSockets();
    const hostSocket = sockets.find((s) => (s.data as MeetingSocketData).userId === hostUserId);
    return hostSocket?.id ?? null;
  } catch {
    return null;
  }
}

function leaveMeeting(socket: Socket): void {
  clearPendingJoin(socket.id);
  const room = socket.data.meetingRoom as string | undefined;
  if (!room) return;
  void socket.leave(room);
  socket.data.meetingRoom = undefined;
  socket.data.meetingId = undefined;
  socket.to(room).emit("meeting:peer-left", { peerId: socket.id });
  if (roomWhiteboardOwner.get(room) === socket.id) {
    roomWhiteboardOwner.delete(room);
    roomWhiteboardEditors.delete(room);
    roomWhiteboardState.set(room, false);
    io.in(room).emit("meeting:whiteboard-state", { active: false, by: socket.id });
    emitWhiteboardPermissions(room);
  } else if (roomWhiteboardEditors.has(room)) {
    roomWhiteboardEditors.get(room)!.delete(socket.id);
    emitWhiteboardPermissions(room);
  }
  const remaining = io.sockets.adapter.rooms.get(room)?.size ?? 0;
  if (remaining <= 1) roomWhiteboardState.delete(room);
  if (remaining <= 1) {
    roomWhiteboardOwner.delete(room);
    roomWhiteboardEditors.delete(room);
    roomHostUserId.delete(room);
    roomPendingJoinIds.delete(room);
  }
}

io.use((socket, next) => {
  const raw = socket.handshake.auth as { token?: unknown };
  const token = typeof raw.token === "string" ? raw.token.trim() : "";
  if (token.length === 0) {
    next(new Error("Unauthorized"));
    return;
  }
  void (async () => {
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
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });
    if (!user) {
      next(new Error("Unauthorized"));
      return;
    }
    (socket.data as MeetingSocketData).userId = userId;
    (socket.data as MeetingSocketData).userName = user.name;
    next();
    } catch {
      next(new Error("Unauthorized"));
    }
  })();
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
    let meeting: { id: string; hostId: string } | null;
    try {
      meeting = await prisma.meeting.findUnique({
        where: { code: trimmed },
        select: { id: true, hostId: true },
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
    clearPendingJoin(socket.id);

    const room = `meeting:${trimmed}`;
    roomHostUserId.set(room, meeting.hostId);
    const userId = (socket.data as MeetingSocketData).userId;
    const isHost = meeting.hostId === userId;

    if (!isHost) {
      pendingJoinBySocketId.set(socket.id, {
        room,
        meetingId: meeting.id,
        code: trimmed,
        requesterName: (socket.data as MeetingSocketData).userName,
        requesterUserId: userId,
      });
      if (!roomPendingJoinIds.has(room)) roomPendingJoinIds.set(room, new Set());
      roomPendingJoinIds.get(room)!.add(socket.id);

      const hostSockets = (await io.in(room).fetchSockets()).filter(
        (s) => (s.data as MeetingSocketData).userId === meeting.hostId,
      );
      for (const hs of hostSockets) {
        io.to(hs.id).emit("meeting:join-request", {
          requestId: socket.id,
          name: (socket.data as MeetingSocketData).userName,
          userId,
        });
      }
      ack({ ok: false, pending: true, message: "Waiting for host approval." });
      return;
    }

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
    (socket.data as MeetingSocketData).meetingId = meeting.id;
    notifyHostOfPending(room, socket.id);

    socket.to(room).emit("meeting:peer-joined", { peerId: socket.id });
    const { chatHistory, chatHasMore } = await loadRecentChat(meeting.id);
    ack({
      ok: true,
      room: trimmed,
      isHost: true,
      hostPeerId: socket.id,
      peerCount: existingIds.length + 1,
      peerIds: existingIds,
      chatHistory,
      chatHasMore,
      whiteboardActive: roomWhiteboardState.get(room) === true,
      whiteboardOwnerId: roomWhiteboardOwner.get(room) ?? null,
      whiteboardEditors: [...(roomWhiteboardEditors.get(room) ?? new Set<string>())],
    });
  });

  socket.on("meeting:chat-history", async (msg: unknown, cb: unknown) => {
    if (typeof cb !== "function") return;
    const ack = cb as (v: Record<string, unknown>) => void;
    const meetingId = (socket.data as MeetingSocketData).meetingId;
    if (!meetingId) {
      ack({ ok: false, error: "Not in a meeting" });
      return;
    }
    if (!msg || typeof msg !== "object") {
      ack({ ok: false, error: "Invalid request" });
      return;
    }
    const payload = msg as {
      beforeCreatedAt?: unknown;
      beforeId?: unknown;
      limit?: unknown;
    };
    if (
      typeof payload.beforeCreatedAt !== "string" ||
      typeof payload.beforeId !== "string"
    ) {
      ack({ ok: false, error: "Missing cursor" });
      return;
    }
    const beforeDate = new Date(payload.beforeCreatedAt);
    if (Number.isNaN(beforeDate.getTime())) {
      ack({ ok: false, error: "Invalid cursor time" });
      return;
    }
    const reqLimit =
      typeof payload.limit === "number" && Number.isInteger(payload.limit)
        ? payload.limit
        : CHAT_PAGE_SIZE;
    const limit = Math.max(1, Math.min(reqLimit, 100));

    try {
      const rows = await prisma.chatMessage.findMany({
        where: {
          meetingId,
          OR: [
            { createdAt: { lt: beforeDate } },
            { createdAt: beforeDate, id: { lt: payload.beforeId } },
          ],
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        select: {
          id: true,
          senderUserId: true,
          senderName: true,
          text: true,
          createdAt: true,
        },
      });
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      ack({
        ok: true,
        hasMore,
        messages: page.reverse().map((m) => ({
          id: m.id,
          senderUserId: m.senderUserId,
          senderName: m.senderName,
          text: m.text,
          createdAt: m.createdAt.toISOString(),
        })),
      });
    } catch (err) {
      console.error(err);
      ack({ ok: false, error: "Could not load chat history" });
    }
  });

  socket.on("meeting:join-decision", async (msg: unknown) => {
    if (!msg || typeof msg !== "object") return;
    const payload = msg as { requestId?: unknown; accepted?: unknown };
    if (typeof payload.requestId !== "string" || typeof payload.accepted !== "boolean") return;

    const requesterSocket = io.sockets.sockets.get(payload.requestId);
    const pending = pendingJoinBySocketId.get(payload.requestId);
    if (!requesterSocket || !pending) {
      clearPendingJoin(payload.requestId);
      return;
    }

    const hostRoom = socket.data.meetingRoom as string | undefined;
    if (!hostRoom || hostRoom !== pending.room) return;
    const hostUserId = roomHostUserId.get(hostRoom);
    if (!hostUserId || hostUserId !== (socket.data as MeetingSocketData).userId) return;

    if (!payload.accepted) {
      clearPendingJoin(payload.requestId);
      io.to(payload.requestId).emit("meeting:join-denied", { message: "Host denied your request." });
      return;
    }

    clearPendingJoin(payload.requestId);
    let existingIds: string[];
    try {
      const existing = await io.in(pending.room).fetchSockets();
      existingIds = existing.map((s) => s.id);
    } catch (err) {
      console.error(err);
      io.to(payload.requestId).emit("meeting:join-denied", { message: "Could not join room." });
      return;
    }

    await requesterSocket.join(pending.room);
    (requesterSocket.data as MeetingSocketData).meetingRoom = pending.room;
    (requesterSocket.data as MeetingSocketData).meetingId = pending.meetingId;
    requesterSocket.to(pending.room).emit("meeting:peer-joined", { peerId: requesterSocket.id });
    const { chatHistory, chatHasMore } = await loadRecentChat(pending.meetingId);
    io.to(payload.requestId).emit("meeting:join-approved", {
      room: pending.code,
      isHost: false,
      hostPeerId: await getHostPeerId(pending.room),
      peerCount: existingIds.length + 1,
      peerIds: existingIds,
      chatHistory,
      chatHasMore,
      whiteboardActive: roomWhiteboardState.get(pending.room) === true,
      whiteboardOwnerId: roomWhiteboardOwner.get(pending.room) ?? null,
      whiteboardEditors: [...(roomWhiteboardEditors.get(pending.room) ?? new Set<string>())],
    });
  });

  socket.on("meeting:host-transfer", (msg: unknown) => {
    const room = socket.data.meetingRoom as string | undefined;
    if (!room) return;
    if (!msg || typeof msg !== "object") return;
    const payload = msg as { to?: unknown };
    if (typeof payload.to !== "string") return;
    if (!targetSharesRoom(socket, payload.to)) return;
    const currentHostUserId = roomHostUserId.get(room);
    const senderUserId = (socket.data as MeetingSocketData).userId;
    if (!currentHostUserId || currentHostUserId !== senderUserId) return;
    const targetSocket = io.sockets.sockets.get(payload.to);
    if (!targetSocket) return;
    const targetUserId = (targetSocket.data as MeetingSocketData).userId;
    roomHostUserId.set(room, targetUserId);
    io.in(room).emit("meeting:host-changed", { hostPeerId: payload.to, hostUserId: targetUserId });
    notifyHostOfPending(room, payload.to);
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

  // ── Remote control ────────────────────────────────────────────────────────

  socket.on("meeting:control-request", (msg: unknown) => {
    if (!msg || typeof msg !== "object") return;
    const m = msg as { to?: unknown };
    if (typeof m.to !== "string") return;
    if (!targetSharesRoom(socket, m.to)) return;
    const fromName = (socket.data as MeetingSocketData).userName;
    io.to(m.to).emit("meeting:control-request", { from: socket.id, fromName });
  });

  socket.on("meeting:control-response", (msg: unknown) => {
    if (!msg || typeof msg !== "object") return;
    const m = msg as { to?: unknown; accepted?: unknown };
    if (typeof m.to !== "string" || typeof m.accepted !== "boolean") return;
    if (!targetSharesRoom(socket, m.to)) return;
    io.to(m.to).emit("meeting:control-response", { from: socket.id, accepted: m.accepted });
  });

  socket.on("meeting:control-event", (msg: unknown) => {
    if (!msg || typeof msg !== "object") return;
    const m = msg as Record<string, unknown>;
    if (typeof m.to !== "string") return;
    if (!targetSharesRoom(socket, m.to)) return;
    const { to, ...rest } = m;
    io.to(to as string).emit("meeting:control-event", { from: socket.id, ...rest });
  });

  socket.on("meeting:control-release", (msg: unknown) => {
    if (!msg || typeof msg !== "object") return;
    const m = msg as { to?: unknown };
    if (typeof m.to !== "string") return;
    if (!targetSharesRoom(socket, m.to)) return;
    io.to(m.to).emit("meeting:control-release", { from: socket.id });
  });

  // ── Screen share state ─────────────────────────────────────────────────────

  socket.on("meeting:screenshare", (msg: unknown) => {
    const room = socket.data.meetingRoom as string | undefined;
    if (!room) return;
    if (!msg || typeof msg !== "object") return;
    const payload = msg as { sharing?: unknown };
    if (typeof payload.sharing !== "boolean") return;
    socket.to(room).emit("meeting:screenshare", { peerId: socket.id, sharing: payload.sharing });
  });

  socket.on("meeting:chat", async (msg: unknown) => {
    const room = socket.data.meetingRoom as string | undefined;
    if (!room) return;
    if (!msg || typeof msg !== "object") return;

    const payload = msg as { text?: unknown };
    if (typeof payload.text !== "string") return;

    const text = payload.text.trim();
    if (text.length === 0 || text.length > 500) return;

    const meetingId = (socket.data as MeetingSocketData).meetingId;
    if (!meetingId) return;

    let persisted: { id: string; createdAt: Date } | null = null;
    try {
      persisted = await prisma.chatMessage.create({
        data: {
          meetingId,
          senderUserId: (socket.data as MeetingSocketData).userId,
          senderName: (socket.data as MeetingSocketData).userName,
          text,
        },
        select: {
          id: true,
          createdAt: true,
        },
      });
    } catch (err) {
      console.error(err);
      return;
    }

    io.in(room).emit("meeting:chat", {
      id: persisted.id,
      senderId: socket.id,
      senderUserId: (socket.data as MeetingSocketData).userId,
      senderName: (socket.data as MeetingSocketData).userName,
      text,
      createdAt: persisted.createdAt.toISOString(),
    });
  });

  // ── Whiteboard ────────────────────────────────────────────────────────────
  socket.on("meeting:whiteboard-state", (msg: unknown) => {
    const room = socket.data.meetingRoom as string | undefined;
    if (!room) return;
    if (!msg || typeof msg !== "object") return;
    const payload = msg as { active?: unknown };
    if (typeof payload.active !== "boolean") return;
    roomWhiteboardState.set(room, payload.active);
    if (payload.active) {
      roomWhiteboardOwner.set(room, socket.id);
      roomWhiteboardEditors.set(room, new Set([socket.id]));
    } else {
      roomWhiteboardOwner.delete(room);
      roomWhiteboardEditors.delete(room);
    }
    io.in(room).emit("meeting:whiteboard-state", { active: payload.active, by: socket.id });
    emitWhiteboardPermissions(room);
  });

  socket.on("meeting:whiteboard-draw", (msg: unknown) => {
    const room = socket.data.meetingRoom as string | undefined;
    if (!room) return;
    if (roomWhiteboardState.get(room) !== true) return;
    const editors = roomWhiteboardEditors.get(room);
    if (!editors || !editors.has(socket.id)) return;
    if (!msg || typeof msg !== "object") return;
    const payload = msg as {
      x0?: unknown;
      y0?: unknown;
      x1?: unknown;
      y1?: unknown;
      color?: unknown;
      width?: unknown;
    };
    if (
      typeof payload.x0 !== "number" ||
      typeof payload.y0 !== "number" ||
      typeof payload.x1 !== "number" ||
      typeof payload.y1 !== "number"
    ) return;
    if (
      payload.x0 < 0 || payload.x0 > 1 ||
      payload.y0 < 0 || payload.y0 > 1 ||
      payload.x1 < 0 || payload.x1 > 1 ||
      payload.y1 < 0 || payload.y1 > 1
    ) return;
    const color = typeof payload.color === "string" ? payload.color : "#ffffff";
    const width = typeof payload.width === "number" ? Math.max(1, Math.min(payload.width, 16)) : 3;
    socket.to(room).emit("meeting:whiteboard-draw", {
      x0: payload.x0,
      y0: payload.y0,
      x1: payload.x1,
      y1: payload.y1,
      color,
      width,
      by: socket.id,
    });
  });

  socket.on("meeting:whiteboard-clear", () => {
    const room = socket.data.meetingRoom as string | undefined;
    if (!room) return;
    if (roomWhiteboardState.get(room) !== true) return;
    const editors = roomWhiteboardEditors.get(room);
    if (!editors || !editors.has(socket.id)) return;
    io.in(room).emit("meeting:whiteboard-clear", { by: socket.id });
  });

  socket.on("meeting:whiteboard-request-edit", () => {
    const room = socket.data.meetingRoom as string | undefined;
    if (!room) return;
    if (roomWhiteboardState.get(room) !== true) return;
    const ownerId = roomWhiteboardOwner.get(room);
    if (!ownerId || ownerId === socket.id) return;
    if (!targetSharesRoom(socket, ownerId)) return;
    const editors = roomWhiteboardEditors.get(room);
    if (editors?.has(socket.id)) return;
    io.to(ownerId).emit("meeting:whiteboard-request-edit", {
      from: socket.id,
      fromName: (socket.data as MeetingSocketData).userName,
    });
  });

  socket.on("meeting:whiteboard-edit-response", (msg: unknown) => {
    const room = socket.data.meetingRoom as string | undefined;
    if (!room) return;
    if (!msg || typeof msg !== "object") return;
    const payload = msg as { to?: unknown; accepted?: unknown };
    if (typeof payload.to !== "string" || typeof payload.accepted !== "boolean") return;
    const ownerId = roomWhiteboardOwner.get(room);
    if (ownerId !== socket.id) return;
    if (!targetSharesRoom(socket, payload.to)) return;
    if (!payload.accepted) {
      io.to(payload.to).emit("meeting:whiteboard-edit-response", { accepted: false, by: socket.id });
      return;
    }
    if (!roomWhiteboardEditors.has(room)) roomWhiteboardEditors.set(room, new Set([socket.id]));
    roomWhiteboardEditors.get(room)!.add(payload.to);
    io.to(payload.to).emit("meeting:whiteboard-edit-response", { accepted: true, by: socket.id });
    emitWhiteboardPermissions(room);
  });

  socket.on("meeting:whiteboard-revoke-edit", (msg: unknown) => {
    const room = socket.data.meetingRoom as string | undefined;
    if (!room) return;
    if (!msg || typeof msg !== "object") return;
    const payload = msg as { userId?: unknown };
    if (typeof payload.userId !== "string") return;
    const ownerId = roomWhiteboardOwner.get(room);
    if (ownerId !== socket.id) return;
    if (payload.userId === ownerId) return;
    if (!targetSharesRoom(socket, payload.userId)) return;
    const editors = roomWhiteboardEditors.get(room);
    if (!editors) return;
    if (!editors.has(payload.userId)) return;
    editors.delete(payload.userId);
    io.to(payload.userId).emit("meeting:whiteboard-edit-revoked", { by: socket.id });
    emitWhiteboardPermissions(room);
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
