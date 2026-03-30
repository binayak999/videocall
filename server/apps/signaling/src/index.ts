import { config as loadEnv } from "dotenv";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import path from "node:path";
import jwt from "jsonwebtoken";
import { prisma } from "@bandr/db";
import { collapseStutteringCaption, mergeCaptionContinuation } from "./captionContinuationMerge";
import { messageFailsChatPolicy } from "./chatPolicy";
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
  userEmail: string;
  meetingRoom?: string;
  meetingId?: string;
  role?: "camera-source" | "live-viewer";
  cameraToken?: string;
  hostSocketId?: string;
  /** Set at handshake for public live watch sockets (must match `live:join` code). */
  liveWatchCode?: string;
}

interface CameraTokenData {
  meetingCode: string;
  hostSocketId: string;
  label: string;
  expiry: number;
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
const CAPTION_PAGE_SIZE = 120;
const CAPTION_TEXT_MAX = 2000;
const cameraTokens = new Map<string, CameraTokenData>();
const roomWhiteboardState = new Map<string, boolean>();
const roomWhiteboardOwner = new Map<string, string>();
const roomWhiteboardEditors = new Map<string, Set<string>>();
const roomHostUserId = new Map<string, string>();
/** True while the meeting host has announced active in-call recording (client-side capture). */
const roomMeetingRecording = new Map<string, boolean>();
const roomPendingJoinIds = new Map<string, Set<string>>();
const pendingJoinBySocketId = new Map<
  string,
  { room: string; meetingId: string; code: string; requesterName: string; requesterUserId: string }
>();

const VOTE_TITLE_MAX = 200;

interface RoomActiveVote {
  /** Same as MeetingPoll.id (persisted). */
  sessionId: string;
  title: string;
  anonymous: boolean;
  meetingId: string;
}

/** Current poll in a meeting room (in-memory; cleared when the room empties or the host leaves). */
const roomActiveVote = new Map<string, RoomActiveVote>();
/** room → voter userId → choice (one vote per account per poll; matches DB) */
const roomVoteByUserId = new Map<string, Map<string, "up" | "down">>();

const ATTENTION_STALE_MS = 45_000;
const ATTENTION_WARN_MESSAGE_MAX = 400;
const MAX_LIVE_VIEWERS_PER_ROOM = 250;

/** When true, anonymous viewers may `live:join` and receive the host WebRTC feed. */
const roomLiveStreamActive = new Map<string, boolean>();

const pendingLiveCollabBySocketId = new Map<
  string,
  { room: string; meetingId: string; code: string; requesterName: string; requesterUserId: string }
>();
const roomPendingLiveCollabIds = new Map<string, Set<string>>();
/** Watch-page users pre-approved to skip the normal join lobby once. */
const roomLiveCollabApprovedUserIds = new Map<string, Set<string>>();

/** room → socketId → latest attention sample from that connection */
const roomAttentionPeers = new Map<
  string,
  Map<string, { userId: string; userName: string; attentive: boolean; at: number }>
>();

function buildAttentionRoster(room: string): {
  userId: string;
  userName: string;
  hasSignal: boolean;
  /** True when at least one connected tab reports the meeting tab visible */
  tabVisible: boolean;
  /** Last report time (ms); 0 if never reported from any tab */
  lastAt: number;
  /** No heartbeat recently — connection or client issue */
  stale: boolean;
  /** Host should nudge: tab hidden / blurred or stale signal */
  needsAttention: boolean;
}[] {
  const peers = roomAttentionPeers.get(room);
  const adapter = io.sockets.adapter.rooms.get(room);
  if (!adapter) return [];
  const now = Date.now();
  const byUser = new Map<
    string,
    { userName: string; hasSignal: boolean; tabVisible: boolean; lastAt: number }
  >();
  for (const sid of adapter) {
    const sock = io.sockets.sockets.get(sid);
    const d = sock?.data as MeetingSocketData | undefined;
    if (!d || d.role === "camera-source" || d.role === "live-viewer") continue;
    const rec = peers?.get(sid);
    const cur = byUser.get(d.userId);
    if (!cur) {
      byUser.set(d.userId, {
        userName: d.userName,
        hasSignal: rec !== undefined,
        tabVisible: rec !== undefined ? rec.attentive : false,
        lastAt: rec !== undefined ? rec.at : 0,
      });
    } else {
      cur.userName = d.userName;
      if (rec !== undefined) {
        cur.hasSignal = true;
        cur.tabVisible = cur.tabVisible || rec.attentive;
        cur.lastAt = Math.max(cur.lastAt, rec.at);
      }
    }
  }
  return [...byUser.entries()].map(([userId, v]) => {
    const stale = v.hasSignal && v.lastAt > 0 && now - v.lastAt > ATTENTION_STALE_MS;
    const needsAttention = v.hasSignal && (stale || !v.tabVisible);
    return {
      userId,
      userName: v.userName,
      hasSignal: v.hasSignal,
      tabVisible: v.tabVisible,
      lastAt: v.lastAt,
      stale,
      needsAttention,
    };
  });
}

function emitAttentionSyncToHosts(room: string): void {
  const hostUserId = roomHostUserId.get(room);
  if (!hostUserId) return;
  const roster = buildAttentionRoster(room);
  const adapter = io.sockets.adapter.rooms.get(room);
  if (!adapter) return;
  for (const sid of adapter) {
    const sock = io.sockets.sockets.get(sid);
    if (sock && (sock.data as MeetingSocketData).userId === hostUserId) {
      io.to(sid).emit("meeting:attention-sync", { roster });
    }
  }
}

function voteCountsForRoom(room: string): { up: number; down: number } {
  const m = roomVoteByUserId.get(room);
  if (!m) return { up: 0, down: 0 };
  let up = 0;
  let down = 0;
  for (const c of m.values()) {
    if (c === "up") up += 1;
    else down += 1;
  }
  return { up, down };
}

function voteBreakdownForRoom(room: string): { peerId: string; userName: string; choice: "up" | "down" }[] {
  const votes = roomVoteByUserId.get(room);
  if (!votes) return [];
  const adapter = io.sockets.adapter.rooms.get(room);
  const out: { peerId: string; userName: string; choice: "up" | "down" }[] = [];
  for (const [userId, choice] of votes) {
    let peerId = "";
    let userName = "Unknown";
    if (adapter) {
      for (const sid of adapter) {
        const sock = io.sockets.sockets.get(sid);
        const d = sock?.data as MeetingSocketData | undefined;
        if (d?.userId === userId) {
          peerId = sid;
          userName = d.userName;
          break;
        }
      }
    }
    out.push({ peerId, userName, choice });
  }
  out.sort((a, b) => a.userName.localeCompare(b.userName, undefined, { sensitivity: "base" }));
  return out;
}

function emitVoteUpdate(room: string): void {
  const active = roomActiveVote.get(room);
  if (!active) return;
  const { up, down } = voteCountsForRoom(room);
  const payload: Record<string, unknown> = {
    sessionId: active.sessionId,
    up,
    down,
  };
  if (!active.anonymous) {
    payload.breakdown = voteBreakdownForRoom(room);
  }
  io.in(room).emit("meeting:vote-update", payload);
}

function emitVoteEnded(room: string, reason: "host-ended" | "host-left"): void {
  const active = roomActiveVote.get(room);
  if (!active) return;
  const { up, down } = voteCountsForRoom(room);
  const payload: Record<string, unknown> = {
    sessionId: active.sessionId,
    title: active.title,
    anonymous: active.anonymous,
    up,
    down,
    reason,
  };
  if (!active.anonymous) {
    payload.breakdown = voteBreakdownForRoom(room);
  }
  void closePollInDb(active.sessionId);
  roomActiveVote.delete(room);
  roomVoteByUserId.delete(room);
  io.in(room).emit("meeting:vote-ended", payload);
}

async function closePollInDb(pollId: string): Promise<void> {
  try {
    await prisma.meetingPoll.update({
      where: { id: pollId },
      data: { endedAt: new Date() },
    });
  } catch (e: unknown) {
    console.error("closePollInDb", e);
  }
}

async function restoreOpenPollForRoom(room: string, meetingId: string): Promise<void> {
  if (roomActiveVote.has(room)) return;
  try {
    const open = await prisma.meetingPoll.findFirst({
      where: { meetingId, endedAt: null },
      orderBy: { createdAt: "desc" },
      include: { votes: true },
    });
    if (!open) return;
    roomActiveVote.set(room, {
      sessionId: open.id,
      title: open.title,
      anonymous: open.anonymous,
      meetingId: open.meetingId,
    });
    const vm = new Map<string, "up" | "down">();
    for (const v of open.votes) {
      const c = v.choice === "up" || v.choice === "down" ? v.choice : "up";
      vm.set(v.voterUserId, c);
    }
    roomVoteByUserId.set(room, vm);
  } catch (e: unknown) {
    console.error("restoreOpenPollForRoom", e);
  }
}

function voteJoinFields(
  room: string,
  userId: string,
): {
  activeVote: { sessionId: string; title: string; anonymous: boolean } | null;
  voteUp: number;
  voteDown: number;
  voteBreakdown?: { peerId: string; userName: string; choice: "up" | "down" }[];
  myVote: "up" | "down" | null;
} {
  const active = roomActiveVote.get(room) ?? null;
  const { up, down } = voteCountsForRoom(room);
  const myChoice = roomVoteByUserId.get(room)?.get(userId) ?? null;
  if (!active) {
    return { activeVote: null, voteUp: 0, voteDown: 0, myVote: null };
  }
  const base = {
    activeVote: {
      sessionId: active.sessionId,
      title: active.title,
      anonymous: active.anonymous,
    },
    voteUp: up,
    voteDown: down,
    myVote: myChoice,
  };
  if (active.anonymous) return base;
  return { ...base, voteBreakdown: voteBreakdownForRoom(room) };
}

function clearRoomVoteIfHostLeft(room: string, leavingUserId: string): void {
  const hostUserId = roomHostUserId.get(room);
  if (!hostUserId || hostUserId !== leavingUserId) return;
  if (!roomActiveVote.has(room)) return;
  emitVoteEnded(room, "host-left");
}

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

async function loadRecentCaptions(meetingId: string): Promise<{
  captionHistory: {
    id: string;
    speakerUserId: string;
    speakerName: string;
    text: string;
    createdAt: string;
  }[];
  captionHasMore: boolean;
}> {
  let captionHistory: {
    id: string;
    speakerUserId: string;
    speakerName: string;
    text: string;
    createdAt: string;
  }[] = [];
  let captionHasMore = false;
  try {
    const rows = await prisma.meetingCaption.findMany({
      where: { meetingId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: CAPTION_PAGE_SIZE + 1,
      select: {
        id: true,
        speakerUserId: true,
        speakerName: true,
        text: true,
        createdAt: true,
      },
    });
    captionHasMore = rows.length > CAPTION_PAGE_SIZE;
    const page = captionHasMore ? rows.slice(0, CAPTION_PAGE_SIZE) : rows;
    captionHistory = page.reverse().map((m) => ({
      ...m,
      createdAt: m.createdAt.toISOString(),
    }));
  } catch (err) {
    console.error(err);
  }
  return { captionHistory, captionHasMore };
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

function clearPendingLiveCollab(socketId: string): void {
  const pending = pendingLiveCollabBySocketId.get(socketId);
  if (!pending) return;
  pendingLiveCollabBySocketId.delete(socketId);
  const inRoom = roomPendingLiveCollabIds.get(pending.room);
  if (!inRoom) return;
  inRoom.delete(socketId);
  if (inRoom.size === 0) roomPendingLiveCollabIds.delete(pending.room);
}

function purgeLiveCollabStateForRoom(room: string): void {
  const ids = [...(roomPendingLiveCollabIds.get(room) ?? [])];
  for (const sid of ids) {
    pendingLiveCollabBySocketId.delete(sid);
  }
  roomPendingLiveCollabIds.delete(room);
  roomLiveCollabApprovedUserIds.delete(room);
}

function notifyHostOfLiveCollabPending(room: string, hostSocketId: string): void {
  const pendingIds = [...(roomPendingLiveCollabIds.get(room) ?? new Set<string>())];
  if (pendingIds.length === 0) return;
  const sockets = io.sockets.sockets;
  for (const sid of pendingIds) {
    const pending = pendingLiveCollabBySocketId.get(sid);
    if (!pending) continue;
    const target = sockets.get(sid);
    if (!target) {
      clearPendingLiveCollab(sid);
      continue;
    }
    io.to(hostSocketId).emit("meeting:live-collab-request", {
      requestId: sid,
      name: pending.requesterName,
      userId: pending.requesterUserId,
    });
  }
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

async function buildJoinApprovedPayload(
  participantSocket: Socket,
  room: string,
  meetingId: string,
  code: string,
): Promise<Record<string, unknown>> {
  await participantSocket.join(room);
  (participantSocket.data as MeetingSocketData).meetingRoom = room;
  (participantSocket.data as MeetingSocketData).meetingId = meetingId;
  const reqData = participantSocket.data as MeetingSocketData;
  await restoreOpenPollForRoom(room, meetingId);
  emitAttentionSyncToHosts(room);
  participantSocket.to(room).emit("meeting:peer-joined", {
    peerId: participantSocket.id,
    userId: reqData.userId,
    userName: reqData.userName,
    userEmail: reqData.userEmail,
  });
  const existing = await io.in(room).fetchSockets();
  const existingIds = existing.map((s) => s.id).filter((id) => id !== participantSocket.id);
  const peerRosterForAck = rosterFromSockets(existing).filter((r) => r.peerId !== participantSocket.id);
  const { chatHistory, chatHasMore } = await loadRecentChat(meetingId);
  const { captionHistory, captionHasMore } = await loadRecentCaptions(meetingId);
  return {
    ok: true,
    room: code,
    isHost: false,
    hostPeerId: await getHostPeerId(room),
    peerCount: existing.length,
    peerIds: existingIds,
    peerRoster: peerRosterForAck,
    selfName: reqData.userName,
    selfEmail: reqData.userEmail,
    chatHistory,
    chatHasMore,
    captionHistory,
    captionHasMore,
    whiteboardActive: roomWhiteboardState.get(room) === true,
    whiteboardOwnerId: roomWhiteboardOwner.get(room) ?? null,
    whiteboardEditors: [...(roomWhiteboardEditors.get(room) ?? new Set<string>())],
    meetingRecordingActive: roomMeetingRecording.get(room) === true,
    ...voteJoinFields(room, reqData.userId),
  };
}

function rosterFromSockets(
  sockets: { id: string; data: unknown }[],
): { peerId: string; userId: string; userName: string; userEmail: string }[] {
  return sockets
    .filter((s) => (s.data as MeetingSocketData).role !== "live-viewer")
    .map((s) => {
      const d = s.data as MeetingSocketData;
      return {
        peerId: s.id,
        userId: d.userId,
        userName: d.userName,
        userEmail: d.userEmail ?? "",
      };
    });
}

function isHostSocketId(room: string, socketId: string): boolean {
  const hostUserId = roomHostUserId.get(room);
  if (!hostUserId) return false;
  const sock = io.sockets.sockets.get(socketId);
  const d = sock?.data as MeetingSocketData | undefined;
  return d !== undefined && d.userId === hostUserId;
}

function countLiveViewersInRoom(room: string): number {
  const adapter = io.sockets.adapter.rooms.get(room);
  if (!adapter) return 0;
  let n = 0;
  for (const sid of adapter) {
    const d = io.sockets.sockets.get(sid)?.data as MeetingSocketData | undefined;
    if (d?.role === "live-viewer") n += 1;
  }
  return n;
}

/**
 * Notify meeting host socket(s) how many public watch-page viewers are in the room.
 * Pass `countOverride` when the public stream is off so the UI does not flash a stale count.
 */
function emitLiveViewerCountToHost(room: string, countOverride?: number): void {
  const hostUserId = roomHostUserId.get(room);
  if (!hostUserId) return;
  const count =
    countOverride !== undefined ? countOverride : countLiveViewersInRoom(room);
  const adapter = io.sockets.adapter.rooms.get(room);
  if (!adapter) return;
  for (const sid of adapter) {
    const s = io.sockets.sockets.get(sid);
    const d = s?.data as MeetingSocketData | undefined;
    if (d?.userId === hostUserId && d.role !== "live-viewer") {
      io.to(sid).emit("meeting:live-viewer-count", { count });
    }
  }
}

function emitPeerLeftToHostOnly(room: string, leavingPeerId: string): void {
  const hostUserId = roomHostUserId.get(room);
  if (!hostUserId) return;
  const adapter = io.sockets.adapter.rooms.get(room);
  if (!adapter) return;
  for (const sid of adapter) {
    const s = io.sockets.sockets.get(sid);
    const d = s?.data as MeetingSocketData | undefined;
    if (d?.userId === hostUserId) {
      io.to(sid).emit("meeting:peer-left", { peerId: leavingPeerId });
      return;
    }
  }
}

function assertWebRtcPeerAllowed(sender: Socket, targetId: string): boolean {
  const room = sender.data.meetingRoom as string | undefined;
  if (!room) return false;
  if (!targetSharesRoom(sender, targetId)) return false;
  const sd = sender.data as MeetingSocketData;
  const td = io.sockets.sockets.get(targetId)?.data as MeetingSocketData | undefined;
  if (!td) return false;
  const sLive = sd.role === "live-viewer";
  const tLive = td.role === "live-viewer";
  if (!sLive && !tLive) return true;
  const sHost = isHostSocketId(room, sender.id);
  const tHost = isHostSocketId(room, targetId);
  if (sLive && tHost) return true;
  if (tLive && sHost) return true;
  return false;
}

function leaveMeeting(socket: Socket): void {
  clearPendingJoin(socket.id);
  clearPendingLiveCollab(socket.id);
  const room = socket.data.meetingRoom as string | undefined;
  if (!room) return;
  const sdLeave = socket.data as MeetingSocketData;
  const hostUserIdForRoomEarly = roomHostUserId.get(room);
  if (hostUserIdForRoomEarly && sdLeave.userId === hostUserIdForRoomEarly) {
    roomLiveStreamActive.delete(room);
    socket.to(room).emit("meeting:live-state", { live: false });
  }
  clearRoomVoteIfHostLeft(room, sdLeave.userId);
  const ap = roomAttentionPeers.get(room);
  if (ap) {
    ap.delete(socket.id);
    if (ap.size === 0) roomAttentionPeers.delete(room);
  }
  emitAttentionSyncToHosts(room);
  void socket.leave(room);
  socket.data.meetingRoom = undefined;
  socket.data.meetingId = undefined;
  if (sdLeave.role === "live-viewer") {
    emitPeerLeftToHostOnly(room, socket.id);
    emitLiveViewerCountToHost(room);
  } else {
    socket.to(room).emit("meeting:peer-left", { peerId: socket.id });
  }
  const hostUserIdForRoom = roomHostUserId.get(room);
  if (
    hostUserIdForRoom &&
    sdLeave.userId === hostUserIdForRoom &&
    roomMeetingRecording.get(room) === true
  ) {
    roomMeetingRecording.delete(room);
    socket.to(room).emit("meeting:recording-state", { active: false, by: socket.id });
  }
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
    const av = roomActiveVote.get(room);
    if (av) void closePollInDb(av.sessionId);
    roomWhiteboardOwner.delete(room);
    roomWhiteboardEditors.delete(room);
    roomHostUserId.delete(room);
    roomMeetingRecording.delete(room);
    roomPendingJoinIds.delete(room);
    roomActiveVote.delete(room);
    roomVoteByUserId.delete(room);
    roomAttentionPeers.delete(room);
    roomLiveStreamActive.delete(room);
    purgeLiveCollabStateForRoom(room);
  }
}

io.use((socket, next) => {
  const raw = socket.handshake.auth as { token?: unknown; cameraToken?: unknown; liveWatchCode?: unknown };

  // Camera-source auth: short-lived token generated by a meeting participant
  if (typeof raw.cameraToken === "string" && raw.cameraToken.trim().length > 0) {
    const ct = cameraTokens.get(raw.cameraToken.trim());
    if (!ct || Date.now() > ct.expiry) {
      next(new Error("Invalid or expired camera token"));
      return;
    }
    const sd = socket.data as MeetingSocketData;
    sd.role = "camera-source";
    sd.cameraToken = raw.cameraToken.trim();
    sd.hostSocketId = ct.hostSocketId;
    sd.userId = "camera-source";
    sd.userName = ct.label;
    sd.userEmail = "";
    next();
    return;
  }

  const liveWatchCode =
    typeof raw.liveWatchCode === "string" ? raw.liveWatchCode.trim() : "";
  if (liveWatchCode.length > 0) {
    void (async () => {
      try {
        const meeting = await prisma.meeting.findUnique({
          where: { code: liveWatchCode },
          select: { id: true },
        });
        if (!meeting) {
          next(new Error("Meeting not found"));
          return;
        }
        const token = typeof raw.token === "string" ? raw.token.trim() : "";
        const sd = socket.data as MeetingSocketData;
        sd.role = "live-viewer";
        sd.liveWatchCode = liveWatchCode;
        if (token.length > 0) {
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
              select: { name: true, email: true },
            });
            if (!user) {
              next(new Error("Unauthorized"));
              return;
            }
            sd.userId = userId;
            sd.userName = user.name;
            sd.userEmail = user.email;
          } catch {
            next(new Error("Unauthorized"));
            return;
          }
        } else {
          sd.userId = `anon:${randomBytes(12).toString("hex")}`;
          sd.userName = "Guest";
          sd.userEmail = "";
        }
        next();
      } catch (e: unknown) {
        console.error("liveWatch handshake", e);
        next(new Error("Unauthorized"));
      }
    })();
    return;
  }

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
      select: { name: true, email: true },
    });
    if (!user) {
      next(new Error("Unauthorized"));
      return;
    }
    (socket.data as MeetingSocketData).userId = userId;
    (socket.data as MeetingSocketData).userName = user.name;
    (socket.data as MeetingSocketData).userEmail = user.email;
    next();
    } catch {
      next(new Error("Unauthorized"));
    }
  })();
});

io.on("connection", (socket) => {
  socket.on("disconnecting", () => {
    const sd = socket.data as MeetingSocketData;
    if (sd.role === "camera-source") {
      if (sd.hostSocketId) {
        io.to(sd.hostSocketId).emit("camera:source-disconnected", { cameraId: socket.id });
      }
      if (sd.cameraToken) cameraTokens.delete(sd.cameraToken);
      return;
    }
    leaveMeeting(socket);
  });

  socket.on("meeting:leave", () => {
    leaveMeeting(socket);
  });

  // ── Multi-camera source ───────────────────────────────────────────────────

  /** Any in-meeting participant generates a one-time token; the camera WebRTC session is with that socket. */
  socket.on("camera:generate-token", (msg: unknown, cb: unknown) => {
    if (typeof cb !== "function") return;
    const ack = cb as (v: Record<string, unknown>) => void;
    const room = (socket.data as MeetingSocketData).meetingRoom;
    if (!room) { ack({ ok: false, error: "Not in meeting" }); return; }
    const label =
      msg && typeof msg === "object" && typeof (msg as { label?: unknown }).label === "string"
        ? (msg as { label: string }).label
        : "Remote Camera";
    const token = randomBytes(16).toString("hex");
    cameraTokens.set(token, {
      meetingCode: room.replace("meeting:", ""),
      hostSocketId: socket.id,
      label,
      expiry: Date.now() + 60 * 60 * 1000, // 1 hour
    });
    ack({ ok: true, token });
  });

  /** Camera source announces it is ready — signals the receiver to start WebRTC. */
  socket.on("camera:ready", (cb: unknown) => {
    const sd = socket.data as MeetingSocketData;
    if (sd.role !== "camera-source" || !sd.hostSocketId) return;
    if (typeof cb === "function") (cb as (v: Record<string, unknown>) => void)({ ok: true });
    io.to(sd.hostSocketId).emit("camera:source-connected", {
      cameraId: socket.id,
      label: sd.userName,
    });
  });

  /** Receiver asks a camera source to send an offer. */
  socket.on("camera:request-offer", (msg: unknown) => {
    if (!msg || typeof msg !== "object") return;
    const m = msg as { to?: unknown; hostId?: unknown };
    if (typeof m.to !== "string" || typeof m.hostId !== "string") return;
    io.to(m.to).emit("camera:request-offer", { hostId: m.hostId });
  });

  /** Camera source sends WebRTC offer to the receiver. */
  socket.on("camera:offer", (msg: unknown) => {
    const sd = socket.data as MeetingSocketData;
    if (sd.role !== "camera-source" || !sd.hostSocketId) return;
    if (!msg || typeof msg !== "object") return;
    const m = msg as { sdp?: unknown };
    if (!m.sdp || typeof m.sdp !== "object") return;
    io.to(sd.hostSocketId).emit("camera:offer", { from: socket.id, sdp: m.sdp });
  });

  /** Receiver sends WebRTC answer back to a camera source. */
  socket.on("camera:answer", (msg: unknown) => {
    if (!msg || typeof msg !== "object") return;
    const m = msg as { to?: unknown; sdp?: unknown };
    if (typeof m.to !== "string" || !m.sdp || typeof m.sdp !== "object") return;
    io.to(m.to).emit("camera:answer", { from: socket.id, sdp: m.sdp });
  });

  /** ICE candidates between camera source and receiver (bidirectional). */
  socket.on("camera:ice", (msg: unknown) => {
    if (!msg || typeof msg !== "object") return;
    const m = msg as { to?: unknown; candidate?: unknown };
    if (typeof m.to !== "string" || !m.candidate || typeof m.candidate !== "object") return;
    io.to(m.to).emit("camera:ice", { from: socket.id, candidate: m.candidate });
  });

  /** Client-side moderation hook — log only; extend for admin webhooks or bans. */
  socket.on("meeting:policy-violation", (msg: unknown) => {
    const room = socket.data.meetingRoom as string | undefined;
    const data = socket.data as MeetingSocketData;
    const code =
      msg && typeof msg === "object" && typeof (msg as { code?: unknown }).code === "string"
        ? (msg as { code: string }).code
        : "unknown";
    console.warn("[meeting:policy-violation]", {
      userId: data.userId,
      socketId: socket.id,
      room,
      code,
    });
  });

  socket.on("meeting:join", async (code: unknown, cb: unknown) => {
    if (typeof cb !== "function") return;
    const ack = cb as (v: Record<string, unknown>) => void;
    if ((socket.data as MeetingSocketData).role === "live-viewer") {
      ack({ ok: false, error: "Use the watch link for public viewing" });
      return;
    }

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
      const collabApproved = roomLiveCollabApprovedUserIds.get(room);
      if (collabApproved?.has(userId)) {
        collabApproved.delete(userId);
        if (collabApproved.size === 0) roomLiveCollabApprovedUserIds.delete(room);
        try {
          ack(await buildJoinApprovedPayload(socket, room, meeting.id, trimmed));
        } catch (err) {
          console.error(err);
          ack({ ok: false, error: "Could not join room" });
        }
        return;
      }
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
    let peerRosterForAck: {
      peerId: string;
      userId: string;
      userName: string;
      userEmail: string;
    }[] = [];
    try {
      const existing = await io.in(room).fetchSockets();
      existingIds = existing.map((s) => s.id);
      peerRosterForAck = rosterFromSockets(existing);
    } catch (err) {
      console.error(err);
      ack({ ok: false, error: "Could not join room" });
      return;
    }

    await socket.join(room);
    (socket.data as MeetingSocketData).meetingRoom = room;
    (socket.data as MeetingSocketData).meetingId = meeting.id;
    notifyHostOfPending(room, socket.id);
    notifyHostOfLiveCollabPending(room, socket.id);
    await restoreOpenPollForRoom(room, meeting.id);
    emitAttentionSyncToHosts(room);

    const selfData = socket.data as MeetingSocketData;
    socket.to(room).emit("meeting:peer-joined", {
      peerId: socket.id,
      userId: selfData.userId,
      userName: selfData.userName,
      userEmail: selfData.userEmail,
    });
    const { chatHistory, chatHasMore } = await loadRecentChat(meeting.id);
    const { captionHistory, captionHasMore } = await loadRecentCaptions(meeting.id);
    ack({
      ok: true,
      room: trimmed,
      isHost: true,
      hostPeerId: socket.id,
      peerCount: existingIds.length + 1,
      peerIds: existingIds,
      peerRoster: peerRosterForAck,
      selfName: selfData.userName,
      selfEmail: selfData.userEmail,
      chatHistory,
      chatHasMore,
      captionHistory,
      captionHasMore,
      whiteboardActive: roomWhiteboardState.get(room) === true,
      whiteboardOwnerId: roomWhiteboardOwner.get(room) ?? null,
      whiteboardEditors: [...(roomWhiteboardEditors.get(room) ?? new Set<string>())],
      meetingRecordingActive: roomMeetingRecording.get(room) === true,
      ...voteJoinFields(room, selfData.userId),
    });
    if (roomLiveStreamActive.get(room)) {
      emitLiveViewerCountToHost(room);
    }
  });

  socket.on("live:join", async (code: unknown, cb: unknown) => {
    if (typeof cb !== "function") return;
    const ack = cb as (v: Record<string, unknown>) => void;
    const data = socket.data as MeetingSocketData;
    if (data.role !== "live-viewer") {
      ack({ ok: false, error: "Invalid session" });
      return;
    }
    const expected = (data.liveWatchCode ?? "").trim();
    if (typeof code !== "string" || code.trim() !== expected || expected.length === 0) {
      ack({ ok: false, error: "Invalid meeting code" });
      return;
    }
    const trimmed = code.trim();
    const room = `meeting:${trimmed}`;
    let meeting: { id: string; title: string | null; host: { name: string } } | null;
    try {
      meeting = await prisma.meeting.findUnique({
        where: { code: trimmed },
        select: { id: true, title: true, host: { select: { name: true } } },
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
    if (!roomLiveStreamActive.get(room)) {
      ack({ ok: false, error: "Live stream is off", streamLive: false });
      return;
    }
    leaveMeeting(socket);
    const hostPeerId = await getHostPeerId(room);
    if (!hostPeerId) {
      ack({ ok: false, error: "Host is not in the call", streamLive: true });
      return;
    }
    if (countLiveViewersInRoom(room) >= MAX_LIVE_VIEWERS_PER_ROOM) {
      ack({ ok: false, error: "Too many viewers — try again later" });
      return;
    }
    await socket.join(room);
    data.meetingRoom = room;
    data.meetingId = meeting.id;
    io.to(hostPeerId).emit("meeting:live-viewer-joined", {
      peerId: socket.id,
      userName: data.userName,
      userId: data.userId,
    });
    emitLiveViewerCountToHost(room);
    const { chatHistory, chatHasMore } = await loadRecentChat(meeting.id);
    const { captionHistory, captionHasMore } = await loadRecentCaptions(meeting.id);
    ack({
      ok: true,
      room: trimmed,
      hostPeerId,
      meetingTitle: meeting.title ?? "",
      hostName: meeting.host.name,
      streamLive: true,
      chatHistory,
      chatHasMore,
      captionHistory,
      captionHasMore,
      ...voteJoinFields(room, data.userId),
    });
  });

  /** Viewer asks host for ICE restart / fresh offer when media is stuck (slow or asymmetric networks). */
  socket.on("live:viewer-request-reoffer", () => {
    const data = socket.data as MeetingSocketData;
    if (data.role !== "live-viewer") return;
    const room = data.meetingRoom;
    if (room === undefined || room.length === 0) return;
    void (async () => {
      const hostPeerId = await getHostPeerId(room);
      if (hostPeerId === null) return;
      io.to(hostPeerId).emit("meeting:live-viewer-request-reoffer", { peerId: socket.id });
    })();
  });

  socket.on("meeting:live-stream", (msg: unknown) => {
    const room = socket.data.meetingRoom as string | undefined;
    if (!room) return;
    const data = socket.data as MeetingSocketData;
    if (data.role === "live-viewer" || data.role === "camera-source") return;
    const hostUserId = roomHostUserId.get(room);
    if (!hostUserId || hostUserId !== data.userId) return;
    if (!msg || typeof msg !== "object") return;
    const live = (msg as { live?: unknown }).live === true;
    if (live) {
      roomLiveStreamActive.set(room, true);
    } else {
      roomLiveStreamActive.delete(room);
    }
    io.in(room).emit("meeting:live-state", { live });
    emitLiveViewerCountToHost(room, live ? undefined : 0);
  });

  socket.on("live:collab-request", (cb?: unknown) => {
    const ack =
      typeof cb === "function" ? (cb as (v: Record<string, unknown>) => void) : (): void => {};
    const data = socket.data as MeetingSocketData;
    if (data.role !== "live-viewer") {
      ack({ ok: false, error: "Only watch viewers can request this" });
      return;
    }
    if (data.userId.startsWith("anon:")) {
      ack({ ok: false, error: "Sign in to ask the host to join the broadcast" });
      return;
    }
    const room = data.meetingRoom;
    const meetingId = data.meetingId;
    if (!room || !meetingId) {
      ack({ ok: false, error: "Not connected to a live stream" });
      return;
    }
    if (!roomLiveStreamActive.get(room)) {
      ack({ ok: false, error: "Live stream is off" });
      return;
    }
    const code = (data.liveWatchCode ?? "").trim() || room.replace("meeting:", "");
    clearPendingLiveCollab(socket.id);
    pendingLiveCollabBySocketId.set(socket.id, {
      room,
      meetingId,
      code,
      requesterName: data.userName,
      requesterUserId: data.userId,
    });
    if (!roomPendingLiveCollabIds.has(room)) roomPendingLiveCollabIds.set(room, new Set());
    roomPendingLiveCollabIds.get(room)!.add(socket.id);
    void (async () => {
      const hostUid = roomHostUserId.get(room);
      if (!hostUid) return;
      const inRoom = await io.in(room).fetchSockets();
      for (const hs of inRoom) {
        if ((hs.data as MeetingSocketData).userId === hostUid) {
          io.to(hs.id).emit("meeting:live-collab-request", {
            requestId: socket.id,
            name: data.userName,
            userId: data.userId,
          });
        }
      }
    })();
    ack({ ok: true, pending: true });
  });

  socket.on("live:collab-decision", (msg: unknown) => {
    if (!msg || typeof msg !== "object") return;
    const payload = msg as { requestId?: unknown; accepted?: unknown };
    if (typeof payload.requestId !== "string" || typeof payload.accepted !== "boolean") return;
    const requesterSocket = io.sockets.sockets.get(payload.requestId);
    const pending = pendingLiveCollabBySocketId.get(payload.requestId);
    if (!requesterSocket || !pending) {
      clearPendingLiveCollab(payload.requestId);
      return;
    }
    const hostRoom = socket.data.meetingRoom as string | undefined;
    if (!hostRoom || hostRoom !== pending.room) return;
    const hostUserId = roomHostUserId.get(hostRoom);
    if (!hostUserId || hostUserId !== (socket.data as MeetingSocketData).userId) return;
    if (!payload.accepted) {
      clearPendingLiveCollab(payload.requestId);
      io.to(payload.requestId).emit("live:collab-denied", {
        message: "The host declined your request.",
      });
      return;
    }
    clearPendingLiveCollab(payload.requestId);
    if (!roomLiveCollabApprovedUserIds.has(pending.room)) {
      roomLiveCollabApprovedUserIds.set(pending.room, new Set());
    }
    roomLiveCollabApprovedUserIds.get(pending.room)!.add(pending.requesterUserId);
    io.to(payload.requestId).emit("live:collab-approved", { meetingCode: pending.code });
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

    const approvedRequesterId = payload.requestId;
    clearPendingJoin(approvedRequesterId);
    void (async () => {
      try {
        const out = await buildJoinApprovedPayload(
          requesterSocket,
          pending.room,
          pending.meetingId,
          pending.code,
        );
        const { ok: _ok, ...forClient } = out;
        io.to(approvedRequesterId).emit("meeting:join-approved", forClient);
      } catch (err) {
        console.error(err);
        io.to(approvedRequesterId).emit("meeting:join-denied", { message: "Could not join room." });
      }
    })();
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
    emitAttentionSyncToHosts(room);
    roomLiveStreamActive.delete(room);
    io.in(room).emit("meeting:live-state", { live: false });

    const meetingId = (socket.data as MeetingSocketData).meetingId;
    if (meetingId) {
      void prisma.meeting
        .update({
          where: { id: meetingId },
          data: { hostId: targetUserId },
        })
        .catch((e: unknown) => {
          console.error("meeting host transfer DB update failed", e);
        });
    }
  });

  socket.on("webrtc:offer", (msg: unknown) => {
    if (!msg || typeof msg !== "object") return;
    const m = msg as { to?: unknown; sdp?: unknown };
    if (typeof m.to !== "string" || !m.sdp || typeof m.sdp !== "object") return;
    if (!assertWebRtcPeerAllowed(socket, m.to)) return;
    io.to(m.to).emit("webrtc:offer", { from: socket.id, sdp: m.sdp });
  });

  socket.on("webrtc:answer", (msg: unknown) => {
    if (!msg || typeof msg !== "object") return;
    const m = msg as { to?: unknown; sdp?: unknown };
    if (typeof m.to !== "string" || !m.sdp || typeof m.sdp !== "object") return;
    if (!assertWebRtcPeerAllowed(socket, m.to)) return;
    io.to(m.to).emit("webrtc:answer", { from: socket.id, sdp: m.sdp });
  });

  socket.on("webrtc:ice", (msg: unknown) => {
    if (!msg || typeof msg !== "object") return;
    const m = msg as { to?: unknown; candidate?: unknown };
    if (typeof m.to !== "string" || !m.candidate || typeof m.candidate !== "object")
      return;
    if (!assertWebRtcPeerAllowed(socket, m.to)) return;
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

  socket.on("meeting:control-unavailable", (msg: unknown) => {
    if (!msg || typeof msg !== "object") return;
    const m = msg as { to?: unknown };
    if (typeof m.to !== "string") return;
    if (!targetSharesRoom(socket, m.to)) return;
    io.to(m.to).emit("meeting:control-unavailable", { from: socket.id });
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

  socket.on("meeting:recording-state", (msg: unknown) => {
    const room = socket.data.meetingRoom as string | undefined;
    if (!room) return;
    if (!msg || typeof msg !== "object") return;
    const payload = msg as { active?: unknown };
    if (typeof payload.active !== "boolean") return;
    const hostUserId = roomHostUserId.get(room);
    const senderUserId = (socket.data as MeetingSocketData).userId;
    if (!hostUserId || hostUserId !== senderUserId) return;
    if (payload.active) {
      roomMeetingRecording.set(room, true);
    } else {
      roomMeetingRecording.delete(room);
    }
    io.in(room).emit("meeting:recording-state", { active: payload.active, by: socket.id });
  });

  socket.on("meeting:vote-start", (msg: unknown) => {
    const room = socket.data.meetingRoom as string | undefined;
    if (!room) return;
    const data = socket.data as MeetingSocketData;
    if (data.role === "camera-source") return;
    const hostUserId = roomHostUserId.get(room);
    if (!hostUserId || hostUserId !== data.userId) return;
    const meetingId = (socket.data as MeetingSocketData).meetingId;
    if (!meetingId) return;
    if (!msg || typeof msg !== "object") return;
    const payload = msg as { title?: unknown; anonymous?: unknown };
    if (typeof payload.title !== "string") return;
    const title = payload.title.trim().slice(0, VOTE_TITLE_MAX);
    if (title.length === 0) return;
    const anonymous = payload.anonymous !== false;
    void (async () => {
      try {
        const poll = await prisma.$transaction(async (tx) => {
          await tx.meetingPoll.updateMany({
            where: { meetingId, endedAt: null },
            data: { endedAt: new Date() },
          });
          return tx.meetingPoll.create({
            data: { meetingId, title, anonymous },
          });
        });
        roomActiveVote.set(room, {
          sessionId: poll.id,
          title: poll.title,
          anonymous: poll.anonymous,
          meetingId: poll.meetingId,
        });
        roomVoteByUserId.set(room, new Map());
        io.in(room).emit("meeting:vote-started", {
          sessionId: poll.id,
          title: poll.title,
          anonymous: poll.anonymous,
          by: socket.id,
        });
        emitVoteUpdate(room);
      } catch (e: unknown) {
        console.error("meeting:vote-start", e);
      }
    })();
  });

  socket.on("meeting:vote-submit", (msg: unknown) => {
    const room = socket.data.meetingRoom as string | undefined;
    if (!room) return;
    const data = socket.data as MeetingSocketData;
    if (data.role === "camera-source") return;
    const voterUserId = data.userId;
    if (voterUserId === "camera-source") return;
    if (data.role === "live-viewer" && voterUserId.startsWith("anon:")) return;
    const active = roomActiveVote.get(room);
    if (!active) return;
    if (!msg || typeof msg !== "object") return;
    const payload = msg as { sessionId?: unknown; choice?: unknown };
    if (typeof payload.sessionId !== "string" || payload.sessionId !== active.sessionId) return;
    if (payload.choice !== "up" && payload.choice !== "down") return;
    const choice = payload.choice;
    void (async () => {
      try {
        const pollRow = await prisma.meetingPoll.findUnique({
          where: { id: active.sessionId },
          select: { endedAt: true },
        });
        if (!pollRow || pollRow.endedAt !== null) return;
        await prisma.meetingPollVote.upsert({
          where: {
            pollId_voterUserId: { pollId: active.sessionId, voterUserId },
          },
          create: {
            pollId: active.sessionId,
            voterUserId,
            voterName: data.userName,
            choice,
          },
          update: { choice, voterName: data.userName },
        });
        if (!roomVoteByUserId.has(room)) roomVoteByUserId.set(room, new Map());
        roomVoteByUserId.get(room)!.set(voterUserId, choice);
        emitVoteUpdate(room);
      } catch (e: unknown) {
        console.error("meeting:vote-submit", e);
      }
    })();
  });

  socket.on("meeting:vote-end", () => {
    const room = socket.data.meetingRoom as string | undefined;
    if (!room) return;
    const data = socket.data as MeetingSocketData;
    if (data.role === "camera-source") return;
    const hostUserId = roomHostUserId.get(room);
    if (!hostUserId || hostUserId !== data.userId) return;
    if (!roomActiveVote.has(room)) return;
    emitVoteEnded(room, "host-ended");
  });

  socket.on("meeting:attention-report", (msg: unknown) => {
    const room = socket.data.meetingRoom as string | undefined;
    if (!room) return;
    const data = socket.data as MeetingSocketData;
    if (data.role === "camera-source" || data.role === "live-viewer") return;
    if (!msg || typeof msg !== "object") return;
    const p = msg as { attentive?: unknown };
    if (typeof p.attentive !== "boolean") return;
    if (!roomAttentionPeers.has(room)) roomAttentionPeers.set(room, new Map());
    roomAttentionPeers.get(room)!.set(socket.id, {
      userId: data.userId,
      userName: data.userName,
      attentive: p.attentive,
      at: Date.now(),
    });
    emitAttentionSyncToHosts(room);
  });

  socket.on("meeting:attention-warn", (msg: unknown) => {
    const room = socket.data.meetingRoom as string | undefined;
    if (!room) return;
    const data = socket.data as MeetingSocketData;
    if (data.role === "camera-source") return;
    const hostUserId = roomHostUserId.get(room);
    if (!hostUserId || hostUserId !== data.userId) return;
    if (!msg || typeof msg !== "object") return;
    const payload = msg as { userId?: unknown; message?: unknown };
    if (typeof payload.userId !== "string") return;
    if (payload.userId === data.userId) return;
    const message =
      typeof payload.message === "string"
        ? payload.message.trim().slice(0, ATTENTION_WARN_MESSAGE_MAX)
        : "";
    const fromName = data.userName;
    const adapter = io.sockets.adapter.rooms.get(room);
    if (!adapter) return;
    for (const sid of adapter) {
      const s = io.sockets.sockets.get(sid);
      const sd = s?.data as MeetingSocketData | undefined;
      if (sd?.userId === payload.userId && sd.role !== "camera-source") {
        io.to(sid).emit("meeting:attention-warning", { fromName, message, by: socket.id });
      }
    }
  });

  socket.on("meeting:host-remove-peer", (msg: unknown) => {
    const room = socket.data.meetingRoom as string | undefined;
    if (!room) return;
    const hostUserId = roomHostUserId.get(room);
    const senderUserId = (socket.data as MeetingSocketData).userId;
    if (!hostUserId || hostUserId !== senderUserId) return;
    if (!msg || typeof msg !== "object") return;
    const peerId = (msg as { peerId?: unknown }).peerId;
    if (typeof peerId !== "string") return;
    const target = io.sockets.sockets.get(peerId);
    if (!target) return;
    const td = target.data as MeetingSocketData;
    if (td.meetingRoom !== room) return;
    if (td.userId === hostUserId) return;
    if (td.role === "live-viewer") return;
    io.to(peerId).emit("meeting:removed-by-host", {
      message: "The host removed you from this call.",
    });
    leaveMeeting(target);
    target.disconnect(true);
  });

  socket.on("meeting:host-mute-peer", (msg: unknown) => {
    const room = socket.data.meetingRoom as string | undefined;
    if (!room) return;
    const hostUserId = roomHostUserId.get(room);
    const senderUserId = (socket.data as MeetingSocketData).userId;
    if (!hostUserId || hostUserId !== senderUserId) return;
    if (!msg || typeof msg !== "object") return;
    const peerId = (msg as { peerId?: unknown }).peerId;
    const muted = (msg as { muted?: unknown }).muted === true;
    if (typeof peerId !== "string") return;
    const target = io.sockets.sockets.get(peerId);
    if (!target) return;
    const td = target.data as MeetingSocketData;
    if (td.meetingRoom !== room) return;
    if (td.userId === hostUserId) return;
    if (td.role === "live-viewer") return;
    io.to(peerId).emit("meeting:host-mic-state", { muted });
  });

  socket.on("meeting:chat", async (msg: unknown) => {
    const room = socket.data.meetingRoom as string | undefined;
    if (!room) return;
    if (!msg || typeof msg !== "object") return;

    const payload = msg as { text?: unknown };
    if (typeof payload.text !== "string") return;

    const text = payload.text.trim();
    if (text.length === 0 || text.length > 500) return;

    const chatPolicy = messageFailsChatPolicy(text);
    if (!chatPolicy.ok) {
      io.to(socket.id).emit("meeting:chat-rejected", { reason: chatPolicy.reason });
      return;
    }

    const chatData = socket.data as MeetingSocketData;
    const meetingId = chatData.meetingId;
    if (!meetingId) return;
    if (chatData.role === "live-viewer" && chatData.userId.startsWith("anon:")) return;

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

  socket.on("meeting:caption", async (msg: unknown) => {
    const sd = socket.data as MeetingSocketData;
    if (sd.role === "camera-source") return;
    const room = sd.meetingRoom as string | undefined;
    if (!room) return;
    if (!msg || typeof msg !== "object") return;
    const payload = msg as { text?: unknown; interim?: unknown };
    if (typeof payload.text !== "string" || typeof payload.interim !== "boolean") return;

    const text = collapseStutteringCaption(
      typeof payload.text === "string" ? payload.text : "",
    );
    if (text.length === 0 || text.length > CAPTION_TEXT_MAX) return;

    const meetingId = sd.meetingId;
    if (!meetingId) return;

    const speakerUserId = sd.userId;
    const speakerName = sd.userName;

    if (payload.interim) {
      io.in(room).emit("meeting:caption", {
        speakerUserId,
        speakerSocketId: socket.id,
        speakerName,
        text,
        interim: true,
      });
      return;
    }

    const CAPTION_EXTEND_WINDOW_MS = 12_000;
    let persisted: { id: string; createdAt: Date };
    try {
      const recent = await prisma.meetingCaption.findFirst({
        where: { meetingId, speakerUserId },
        orderBy: { createdAt: "desc" },
        select: { id: true, text: true, createdAt: true },
      });
      if (recent) {
        const ageMs = Date.now() - recent.createdAt.getTime();
        const prevT = recent.text.trim();
        if (ageMs < CAPTION_EXTEND_WINDOW_MS) {
          if (prevT === text) {
            return;
          }
          const { merged, kind } = mergeCaptionContinuation(prevT, text);
          if (kind === "identical") {
            return;
          }
          if (kind !== "concat") {
            if (merged === prevT) {
              return;
            }
            persisted = await prisma.meetingCaption.update({
              where: { id: recent.id },
              data: { text: merged },
              select: { id: true, createdAt: true },
            });
            io.in(room).emit("meeting:caption", {
              id: persisted.id,
              speakerUserId,
              speakerSocketId: socket.id,
              speakerName,
              text: merged,
              interim: false,
              createdAt: persisted.createdAt.toISOString(),
            });
            return;
          }
        }
      }

      persisted = await prisma.meetingCaption.create({
        data: {
          meetingId,
          speakerUserId,
          speakerName,
          text,
        },
        select: { id: true, createdAt: true },
      });
    } catch (err) {
      console.error(err);
      return;
    }

    io.in(room).emit("meeting:caption", {
      id: persisted.id,
      speakerUserId,
      speakerSocketId: socket.id,
      speakerName,
      text,
      interim: false,
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
