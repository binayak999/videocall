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
  /** @type {RTCPeerConnection | null} */
  let pc = null;
  /** @type {MediaStream | null} */
  let localStream = null;
  /** @type {RTCIceCandidateInit[]} */
  const pendingRemoteIce = [];
  let remoteDescriptionReady = false;
  /** Set after successful meeting:join ack */
  let iAmHost = false;

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

  function resetPeerConnection() {
    pendingRemoteIce.length = 0;
    remoteDescriptionReady = false;
    if (pc) {
      pc.close();
      pc = null;
    }
    const remoteVideo = /** @type {HTMLVideoElement} */ (el("remote"));
    remoteVideo.srcObject = null;
  }

  function flushIce() {
    if (!pc) return;
    while (pendingRemoteIce.length > 0) {
      const c = pendingRemoteIce.shift();
      if (c) {
        void pc.addIceCandidate(c).catch(() => {});
      }
    }
  }

  async function ensureStream() {
    if (localStream) return localStream;
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    const localVideo = /** @type {HTMLVideoElement} */ (el("local"));
    localVideo.srcObject = localStream;
    return localStream;
  }

  function ensurePc() {
    if (pc) return pc;
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    if (localStream) {
      for (const t of localStream.getTracks()) {
        pc.addTrack(t, localStream);
      }
    }
    pc.ontrack = (ev) => {
      const remoteVideo = /** @type {HTMLVideoElement} */ (el("remote"));
      const s = ev.streams[0];
      if (s) remoteVideo.srcObject = s;
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate && socket?.connected) {
        socket.emit("webrtc:ice", { candidate: ev.candidate.toJSON() });
      }
    };
    pc.onconnectionstatechange = () => {
      if (!pc) return;
      log("pc.connectionState", pc.connectionState);
      if (
        pc.connectionState === "failed" ||
        pc.connectionState === "disconnected"
      ) {
        setStatus(`Peer connection: ${pc.connectionState}`);
      }
      if (pc.connectionState === "connected") {
        setStatus("WebRTC connected");
      }
    };
    return pc;
  }

  async function createAndSendOffer() {
    const p = ensurePc();
    const offer = await p.createOffer();
    await p.setLocalDescription(offer);
    const sdp = p.localDescription?.toJSON();
    if (sdp && socket?.connected) {
      socket.emit("webrtc:offer", { sdp });
      log("sent offer");
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
      log("signaling connected", socket.id);
    });
    socket.on("connect_error", (err) => {
      log("connect_error", err.message);
      setStatus(`Signaling failed: ${err.message}`);
      el("btn-connect").disabled = false;
    });
    socket.on("disconnect", (reason) => {
      log("signaling disconnected", reason);
    });

    socket.on("meeting:peer-joined", () => {
      log("meeting:peer-joined");
      if (iAmHost) {
        void createAndSendOffer().catch((e) => log("offer error", String(e)));
      }
    });

    socket.on("webrtc:offer", async (msg) => {
      if (!msg || typeof msg !== "object") return;
      if (!("sdp" in msg)) return;
      const sdpUnknown = msg.sdp;
      if (!sdpUnknown || typeof sdpUnknown !== "object") return;
      const p = ensurePc();
      try {
        await p.setRemoteDescription(
          /** @type {RTCSessionDescriptionInit} */ (sdpUnknown),
        );
        remoteDescriptionReady = true;
        flushIce();
        if (!iAmHost) {
          const answer = await p.createAnswer();
          await p.setLocalDescription(answer);
          const local = p.localDescription?.toJSON();
          if (local && socket?.connected) {
            socket.emit("webrtc:answer", { sdp: local });
            log("sent answer");
          }
        }
      } catch (e) {
        log("webrtc:offer error", String(e));
      }
    });

    socket.on("webrtc:answer", async (msg) => {
      if (!iAmHost) return;
      if (!msg || typeof msg !== "object" || !("sdp" in msg)) return;
      const sdpUnknown = msg.sdp;
      if (!sdpUnknown || typeof sdpUnknown !== "object" || !pc) return;
      try {
        await pc.setRemoteDescription(
          /** @type {RTCSessionDescriptionInit} */ (sdpUnknown),
        );
        remoteDescriptionReady = true;
        flushIce();
        log("set remote answer");
      } catch (e) {
        log("webrtc:answer error", String(e));
      }
    });

    socket.on("webrtc:ice", async (msg) => {
      if (!msg || typeof msg !== "object" || !("candidate" in msg)) return;
      const candidate = msg.candidate;
      if (!candidate || typeof candidate !== "object") return;
      if (!pc) {
        pendingRemoteIce.push(
          /** @type {RTCIceCandidateInit} */ (candidate),
        );
        return;
      }
      if (!remoteDescriptionReady) {
        pendingRemoteIce.push(
          /** @type {RTCIceCandidateInit} */ (candidate),
        );
        return;
      }
      try {
        await pc.addIceCandidate(
          /** @type {RTCIceCandidateInit} */ (candidate),
        );
      } catch {
        /* ignore */
      }
    });

    socket.on("meeting:peer-left", () => {
      log("meeting:peer-left");
      setStatus("Peer left — you can leave or reconnect.");
      resetPeerConnection();
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
    iAmHost = false;
    resetPeerConnection();

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

      iAmHost = Boolean(ack.isHost);
      log("meeting:join ack", ack);
      setStatus(
        ack.isHost
          ? "In room — waiting for second participant…"
          : "In room — negotiating WebRTC…",
      );
      el("btn-leave").disabled = false;
    });
  }

  function leave() {
    socket?.emit("meeting:leave");
    socket?.disconnect();
    socket = null;
    iAmHost = false;
    resetPeerConnection();
    el("btn-leave").disabled = true;
    el("btn-connect").disabled = false;
    setStatus("Left room");
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
