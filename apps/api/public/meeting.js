/* global io */
(function () {
  const TOKEN_KEY = "meetclone_jwt";
  const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

  /**
   * Dev: page on :4001 → signaling on :4002. Production (nginx on 443): same origin, /socket.io proxied to signaling.
   */
  function defaultSignalingUrl() {
    const { hostname, protocol, port } = window.location;
    const defaultHttps = protocol === "https:" && (port === "" || port === "443");
    const defaultHttp = protocol === "http:" && (port === "" || port === "80");
    if (defaultHttps || defaultHttp) {
      return `${protocol}//${hostname}`;
    }
    return `${protocol}//${hostname}:4002`;
  }

  /** @type {import("socket.io-client").Socket | null} */
  let socket = null;
  /** @type {MediaStream | null} */
  let localStream = null;
  /** @type {string} */
  let mySocketId = "";

  /**
   * @typedef {{ pc: RTCPeerConnection; pendingIce: RTCIceCandidateInit[]; remoteDescriptionReady: boolean; videoBox: HTMLElement }} PeerState
   */

  /** @type {Map<string, PeerState>} */
  const peers = new Map();
  /** ICE can arrive before the first SDP; buffer per peer until PC exists. */
  /** @type {Map<string, RTCIceCandidateInit[]>} */
  const preConnectIce = new Map();

  /**
   * @param {string} id
   * @returns {HTMLElement}
   */
  function el(id) {
    const node = document.getElementById(id);
    if (!node) {
      throw new Error(`Missing #${id}`);
    }
    return node;
  }

  function log(...args) {
    const pre = el("log");
    const line = args
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ");
    pre.textContent += `${line}\n`;
    pre.scrollTop = pre.scrollHeight;
  }

  function setStatus(text) {
    el("status-line").textContent = text;
  }

  /**
   * Lower socket.io id sends the offer for that pair (avoids offer/answer glare).
   * @param {string} remoteId
   */
  function shouldInitiateOffer(remoteId) {
    return mySocketId.length > 0 && mySocketId < remoteId;
  }

  function shortId(id) {
    return id.length <= 8 ? id : `${id.slice(0, 6)}…`;
  }

  function removePeer(remoteId) {
    const state = peers.get(remoteId);
    if (state) {
      state.pc.close();
      state.videoBox.remove();
    }
    peers.delete(remoteId);
    preConnectIce.delete(remoteId);
  }

  function resetAllPeers() {
    for (const id of [...peers.keys()]) {
      removePeer(id);
    }
    preConnectIce.clear();
  }

  function flushPendingIce(state) {
    while (state.pendingIce.length > 0) {
      const c = state.pendingIce.shift();
      if (c) {
        void state.pc.addIceCandidate(c).catch(() => {});
      }
    }
  }

  /**
   * @param {string} remoteId
   * @returns {PeerState}
   */
  function ensurePeerState(remoteId) {
    let state = peers.get(remoteId);
    if (state) {
      return state;
    }

    const remoteRoot = el("remote-videos");
    const videoBox = document.createElement("div");
    videoBox.className = "video-box";
    const video = document.createElement("video");
    video.playsInline = true;
    video.autoplay = true;
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = `Peer ${shortId(remoteId)}`;
    videoBox.appendChild(video);
    videoBox.appendChild(label);
    remoteRoot.appendChild(videoBox);

    const pendingIce = /** @type {RTCIceCandidateInit[]} */ ([]);
    let remoteDescriptionReady = false;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    if (localStream) {
      for (const t of localStream.getTracks()) {
        pc.addTrack(t, localStream);
      }
    }
    pc.ontrack = (ev) => {
      const s = ev.streams[0];
      if (s) {
        video.srcObject = s;
      }
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate && socket?.connected) {
        socket.emit("webrtc:ice", {
          to: remoteId,
          candidate: ev.candidate.toJSON(),
        });
      }
    };
    pc.onconnectionstatechange = () => {
      log(`pc[${shortId(remoteId)}].connectionState`, pc.connectionState);
    };

    state = { pc, pendingIce, remoteDescriptionReady, videoBox };
    peers.set(remoteId, state);

    const early = preConnectIce.get(remoteId);
    if (early) {
      for (const c of early) {
        pendingIce.push(c);
      }
      preConnectIce.delete(remoteId);
    }

    return state;
  }

  async function createAndSendOffer(remoteId) {
    await ensureStream();
    const state = ensurePeerState(remoteId);
    const offer = await state.pc.createOffer();
    await state.pc.setLocalDescription(offer);
    const sdp = state.pc.localDescription?.toJSON();
    if (sdp && socket?.connected) {
      socket.emit("webrtc:offer", { to: remoteId, sdp });
      log("sent offer →", shortId(remoteId));
    }
  }

  function registerSocketHandlers() {
    if (!socket) return;

    socket.off("connect");
    socket.off("connect_error");
    socket.off("disconnect");
    socket.off("meeting:peer-joined");
    socket.off("webrtc:offer");
    socket.off("webrtc:answer");
    socket.off("webrtc:ice");
    socket.off("meeting:peer-left");

    socket.on("connect", () => {
      mySocketId = socket.id;
      log("signaling connected", mySocketId);
    });
    socket.on("connect_error", (err) => {
      log("connect_error", err.message);
      setStatus(`Signaling failed: ${err.message}`);
      el("btn-connect").disabled = false;
    });
    socket.on("disconnect", (reason) => {
      log("signaling disconnected", reason);
    });

    socket.on("meeting:peer-joined", (payload) => {
      if (!payload || typeof payload !== "object") return;
      const peerId = payload.peerId;
      if (typeof peerId !== "string" || peerId === mySocketId) return;
      log("meeting:peer-joined", shortId(peerId));
      if (shouldInitiateOffer(peerId)) {
        void createAndSendOffer(peerId).catch((e) =>
          log("offer error", String(e)),
        );
      }
    });

    socket.on("webrtc:offer", async (msg) => {
      if (!msg || typeof msg !== "object") return;
      const from = msg.from;
      if (typeof from !== "string") return;
      if (!("sdp" in msg)) return;
      const sdpUnknown = msg.sdp;
      if (!sdpUnknown || typeof sdpUnknown !== "object") return;

      const state = ensurePeerState(from);
      try {
        await state.pc.setRemoteDescription(
          /** @type {RTCSessionDescriptionInit} */ (sdpUnknown),
        );
        state.remoteDescriptionReady = true;
        flushPendingIce(state);
        const answer = await state.pc.createAnswer();
        await state.pc.setLocalDescription(answer);
        const local = state.pc.localDescription?.toJSON();
        if (local && socket?.connected) {
          socket.emit("webrtc:answer", { to: from, sdp: local });
          log("sent answer →", shortId(from));
        }
      } catch (e) {
        log("webrtc:offer error", String(e));
      }
    });

    socket.on("webrtc:answer", async (msg) => {
      if (!msg || typeof msg !== "object") return;
      const from = msg.from;
      if (typeof from !== "string") return;
      if (!("sdp" in msg)) return;
      const sdpUnknown = msg.sdp;
      if (!sdpUnknown || typeof sdpUnknown !== "object") return;

      const state = peers.get(from);
      if (!state) return;
      try {
        await state.pc.setRemoteDescription(
          /** @type {RTCSessionDescriptionInit} */ (sdpUnknown),
        );
        state.remoteDescriptionReady = true;
        flushPendingIce(state);
        log("set remote answer ←", shortId(from));
      } catch (e) {
        log("webrtc:answer error", String(e));
      }
    });

    socket.on("webrtc:ice", async (msg) => {
      if (!msg || typeof msg !== "object") return;
      const from = msg.from;
      if (typeof from !== "string") return;
      if (!("candidate" in msg)) return;
      const candidate = msg.candidate;
      if (!candidate || typeof candidate !== "object") return;
      const init = /** @type {RTCIceCandidateInit} */ (candidate);

      let state = peers.get(from);
      if (!state) {
        if (!preConnectIce.has(from)) {
          preConnectIce.set(from, []);
        }
        preConnectIce.get(from)?.push(init);
        return;
      }
      if (!state.remoteDescriptionReady) {
        state.pendingIce.push(init);
        return;
      }
      try {
        await state.pc.addIceCandidate(init);
      } catch {
        /* ignore */
      }
    });

    socket.on("meeting:peer-left", (payload) => {
      const peerId =
        payload && typeof payload === "object" && "peerId" in payload
          ? payload.peerId
          : undefined;
      if (typeof peerId === "string") {
        log("meeting:peer-left", shortId(peerId));
        removePeer(peerId);
        setStatus(`Peer left (${shortId(peerId)}) — ${peers.size} in call`);
      } else {
        log("meeting:peer-left (full reset)");
        resetAllPeers();
        setStatus("Room changed — peers reset.");
      }
    });
  }

  async function connect() {
    const token = window.localStorage.getItem(TOKEN_KEY);
    if (!token) {
      setStatus("No JWT — register or log in on the dashboard first.");
      return;
    }

    const rawSignal =
      /** @type {HTMLInputElement} */ (el("input-signal")).value.trim();
    const signalBase =
      rawSignal.length > 0 ? rawSignal : defaultSignalingUrl();
    const code = /** @type {HTMLInputElement} */ (el("input-code")).value.trim();
    if (!code) {
      setStatus("Enter a meeting code.");
      return;
    }

    if (typeof io !== "function") {
      setStatus("Socket.io client failed to load (check network / CDN).");
      return;
    }

    el("btn-connect").disabled = true;
    setStatus("Connecting…");
    el("log").textContent = "";
    mySocketId = "";
    resetAllPeers();

    try {
      await ensureStream();
    } catch (e) {
      setStatus("Camera/mic unavailable or permission denied.");
      log(String(e));
      el("btn-connect").disabled = false;
      return;
    }

    if (socket?.connected) {
      socket.disconnect();
    }

    socket = io(signalBase, {
      auth: { token },
      transports: ["websocket", "polling"],
    });

    registerSocketHandlers();

    socket.emit("meeting:join", code, (ack) => {
      if (!ack || typeof ack !== "object") {
        setStatus("Invalid join response");
        el("btn-connect").disabled = false;
        return;
      }
      if (!("ok" in ack) || ack.ok !== true) {
        const err =
          "error" in ack && typeof ack.error === "string"
            ? ack.error
            : "Join failed";
        setStatus(err);
        log(ack);
        el("btn-connect").disabled = false;
        socket?.disconnect();
        return;
      }

      mySocketId = socket?.id ?? mySocketId;
      log("meeting:join ack", ack);

      const peerIds =
        "peerIds" in ack && Array.isArray(ack.peerIds)
          ? ack.peerIds.filter((id) => typeof id === "string")
          : [];

      for (const pid of peerIds) {
        if (shouldInitiateOffer(pid)) {
          void createAndSendOffer(pid).catch((e) =>
            log("offer error", String(e)),
          );
        }
      }

      const n = typeof ack.peerCount === "number" ? ack.peerCount : peerIds.length + 1;
      setStatus(
        n <= 1
          ? "In room — waiting for others…"
          : `In room — ${n} participants (mesh WebRTC)`,
      );
      el("btn-leave").disabled = false;
    });
  }

  function leave() {
    socket?.emit("meeting:leave");
    socket?.disconnect();
    socket = null;
    mySocketId = "";
    resetAllPeers();
    el("btn-leave").disabled = true;
    el("btn-connect").disabled = false;
    setStatus("Left room");
  }

  async function ensureStream() {
    if (localStream) {
      return localStream;
    }
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    const localVideo = /** @type {HTMLVideoElement} */ (el("local"));
    localVideo.srcObject = localStream;
    return localStream;
  }

  function initDefaults() {
    const params = new URLSearchParams(window.location.search);
    const signal = params.get("signal");
    const code = params.get("code");
    const signalInput = /** @type {HTMLInputElement} */ (el("input-signal"));
    const codeInput = /** @type {HTMLInputElement} */ (el("input-code"));
    if (signal) signalInput.value = signal;
    else signalInput.value = defaultSignalingUrl();
    if (code) codeInput.value = code;
  }

  el("btn-connect").addEventListener("click", () => {
    void connect();
  });
  el("btn-leave").addEventListener("click", () => {
    leave();
  });

  initDefaults();
})();
