import type { Server, Socket } from "socket.io";

const ROOM_PREFIX = "meeting:";

function roomIdForCode(code: string): string {
  return `${ROOM_PREFIX}${code.trim()}`;
}

type JoinAck =
  | { ok: true; room: string; isHost: boolean; peerCount: number }
  | { ok: false; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function registerMeetingSignaling(io: Server): void {
  io.on("connection", (socket: Socket) => {
    socket.on("meeting:join", (raw: unknown, ack?: (r: JoinAck) => void) => {
      const code = typeof raw === "string" ? raw.trim() : "";
      if (code.length === 0) {
        ack?.({ ok: false, error: "Missing meeting code" });
        return;
      }

      const room = roomIdForCode(code);
      const before = io.sockets.adapter.rooms.get(room)?.size ?? 0;
      if (before >= 2) {
        ack?.({ ok: false, error: "Room is full (max 2 peers for P2P demo)" });
        return;
      }

      const prev = socket.data.currentRoom;
      if (prev !== undefined && prev !== room) {
        void socket.leave(prev);
        socket.to(prev).emit("meeting:peer-left", { reason: "switched-room" });
      }

      void socket.join(room);
      socket.data.currentRoom = room;

      const peerCount = io.sockets.adapter.rooms.get(room)?.size ?? 0;
      const isHost = peerCount === 1;

      socket.to(room).emit("meeting:peer-joined", {
        peerId: socket.id,
        userId: socket.data.userId,
      });

      ack?.({
        ok: true,
        room: code,
        isHost,
        peerCount,
      });
    });

    socket.on("meeting:leave", () => {
      leaveCurrentRoom(socket, "left");
    });

    socket.on("webrtc:offer", (payload: unknown) => {
      relayWebRtc(socket, "webrtc:offer", payload);
    });

    socket.on("webrtc:answer", (payload: unknown) => {
      relayWebRtc(socket, "webrtc:answer", payload);
    });

    socket.on("webrtc:ice", (payload: unknown) => {
      relayWebRtc(socket, "webrtc:ice", payload);
    });

    socket.on("disconnect", () => {
      leaveCurrentRoom(socket, "disconnect");
    });
  });
}

function leaveCurrentRoom(socket: Socket, reason: string): void {
  const room = socket.data.currentRoom;
  if (room === undefined) {
    return;
  }
  socket.data.currentRoom = undefined;
  void socket.leave(room);
  socket.to(room).emit("meeting:peer-left", { reason });
}

function relayWebRtc(
  socket: Socket,
  event: "webrtc:offer" | "webrtc:answer" | "webrtc:ice",
  payload: unknown,
): void {
  const room = socket.data.currentRoom;
  if (room === undefined) {
    return;
  }
  if (!isRecord(payload)) {
    return;
  }
  socket.to(room).emit(event, payload);
}
