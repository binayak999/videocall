import type { Server } from "socket.io";
/** Full mesh: each client opens one RTCPeerConnection per remote peer (no SFU). */
export declare const MAX_MEETING_PEERS = 20;
export declare function registerMeetingSignaling(io: Server): void;
//# sourceMappingURL=meetingSignaling.d.ts.map