import type { Server, Socket } from "socket.io";

const ROOM_PREFIX = "meeting:";

/** Full mesh: each client opens one RTCPeerConnection per remote peer (no SFU). */
export const MAX_MEETING_PEERS = 20;

function roomIdForCode(code: string): string {
  return `${ROOM_PREFIX}${code.trim()}`;
}

type JoinAck =
  | {
      ok: true;
      room: string;
      isHost: boolean;
      peerCount: number;
      /** Other participants' socket ids (mesh signaling). */
      peerIds: string[];
    }
  | { ok: false; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function registerMeetingSignaling(io: Server): void {
  io.on("connection", (socket: Socket) => {
    socket.on(
      "meeting:join",
      async (raw: unknown, ack?: (r: JoinAck) => void) => {
        const code = typeof raw === "string" ? raw.trim() : "";
        if (code.length === 0) {
          ack?.({ ok: false, error: "Missing meeting code" });
          return;
        }

        const room = roomIdForCode(code);
        const before = io.sockets.adapter.rooms.get(room)?.size ?? 0;
        if (before >= MAX_MEETING_PEERS) {
          ack?.({
            ok: false,
            error: `Room is full (max ${MAX_MEETING_PEERS} participants)`,
          });
          return;
        }

        const prev = socket.data.currentRoom;
        if (prev !== undefined && prev !== room) {
          void socket.leave(prev);
          socket.to(prev).emit("meeting:peer-left", {
            reason: "switched-room",
            peerId: socket.id,
          });
        }

        await socket.join(room);
        socket.data.currentRoom = room;

        const roomSockets = io.sockets.adapter.rooms.get(room);
        const peerCount = roomSockets?.size ?? 0;
        const isHost = peerCount === 1;

        const peerIds: string[] = [];
        if (roomSockets !== undefined) {
          for (const sid of roomSockets) {
            if (sid !== socket.id) {
              peerIds.push(sid);
            }
          }
        }

        socket.to(room).emit("meeting:peer-joined", {
          peerId: socket.id,
          userId: socket.data.userId,
        });

        ack?.({
          ok: true,
          room: code,
          isHost,
          peerCount,
          peerIds,
        });
      },
    );

    socket.on("meeting:leave", () => {
      leaveCurrentRoom(socket, "left");
    });

    socket.on("webrtc:offer", (payload: unknown) => {
      relayWebRtc(io, socket, "webrtc:offer", payload);
    });

    socket.on("webrtc:answer", (payload: unknown) => {
      relayWebRtc(io, socket, "webrtc:answer", payload);
    });

    socket.on("webrtc:ice", (payload: unknown) => {
      relayWebRtc(io, socket, "webrtc:ice", payload);
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
  socket.to(room).emit("meeting:peer-left", { reason, peerId: socket.id });
}

function relayWebRtc(
  io: Server,
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
  const to = payload.to;
  if (typeof to !== "string" || to.length === 0) {
    return;
  }
  const target = io.sockets.sockets.get(to);
  if (target === undefined || target.data.currentRoom !== room) {
    return;
  }
  const forward: Record<string, unknown> = { ...payload, from: socket.id };
  delete forward.to;
  target.emit(event, forward);
}
