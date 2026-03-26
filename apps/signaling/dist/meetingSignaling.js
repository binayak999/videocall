"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_MEETING_PEERS = void 0;
exports.registerMeetingSignaling = registerMeetingSignaling;
const ROOM_PREFIX = "meeting:";
/** Full mesh: each client opens one RTCPeerConnection per remote peer (no SFU). */
exports.MAX_MEETING_PEERS = 20;
function roomIdForCode(code) {
    return `${ROOM_PREFIX}${code.trim()}`;
}
function isRecord(v) {
    return typeof v === "object" && v !== null;
}
function registerMeetingSignaling(io) {
    io.on("connection", (socket) => {
        socket.on("meeting:join", async (raw, ack) => {
            const code = typeof raw === "string" ? raw.trim() : "";
            if (code.length === 0) {
                ack?.({ ok: false, error: "Missing meeting code" });
                return;
            }
            const room = roomIdForCode(code);
            const before = io.sockets.adapter.rooms.get(room)?.size ?? 0;
            if (before >= exports.MAX_MEETING_PEERS) {
                ack?.({
                    ok: false,
                    error: `Room is full (max ${exports.MAX_MEETING_PEERS} participants)`,
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
            const peerIds = [];
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
        });
        socket.on("meeting:leave", () => {
            leaveCurrentRoom(socket, "left");
        });
        socket.on("webrtc:offer", (payload) => {
            relayWebRtc(io, socket, "webrtc:offer", payload);
        });
        socket.on("webrtc:answer", (payload) => {
            relayWebRtc(io, socket, "webrtc:answer", payload);
        });
        socket.on("webrtc:ice", (payload) => {
            relayWebRtc(io, socket, "webrtc:ice", payload);
        });
        socket.on("disconnect", () => {
            leaveCurrentRoom(socket, "disconnect");
        });
    });
}
function leaveCurrentRoom(socket, reason) {
    const room = socket.data.currentRoom;
    if (room === undefined) {
        return;
    }
    socket.data.currentRoom = undefined;
    void socket.leave(room);
    socket.to(room).emit("meeting:peer-left", { reason, peerId: socket.id });
}
function relayWebRtc(io, socket, event, payload) {
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
    const forward = { ...payload, from: socket.id };
    delete forward.to;
    target.emit(event, forward);
}
//# sourceMappingURL=meetingSignaling.js.map