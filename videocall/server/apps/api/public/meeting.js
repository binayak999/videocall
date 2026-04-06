/* global io */
(function () {
  'use strict';

  const TOKEN_KEY = 'meetclone_jwt';
  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

  /** @type {import("socket.io-client").Socket | null} */
  let socket = null;
  /** @type {MediaStream | null} */
  let localStream = null;
  let mySocketId = '';
  let micEnabled = true;
  let camEnabled = true;
  let timerInterval = null;
  let timerSeconds = 0;

  /**
   * @typedef {{ pc: RTCPeerConnection; pendingIce: RTCIceCandidateInit[]; remoteDescriptionReady: boolean; videoBox: HTMLElement }} PeerState
   */
  /** @type {Map<string, PeerState>} */
  const peers = new Map();
  /** @type {Map<string, RTCIceCandidateInit[]>} */
  const preConnectIce = new Map();

  // ─── DOM helpers ─────────────────────────────────────────────────────────

  function el(id) {
    const node = document.getElementById(id);
    if (!node) throw new Error('Missing #' + id);
    return node;
  }

  function show(id) { el(id).style.display = ''; }
  function hide(id) { el(id).style.display = 'none'; }
  function showFlex(id) { el(id).style.display = 'flex'; }

  function log(...args) {
    const pre = el('log');
    const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    pre.textContent += line + '\n';
    pre.scrollTop = pre.scrollHeight;
  }

  let toastTimer = null;
  function showToast(text, duration = 3500) {
    const t = el('toast');
    el('toast-msg').textContent = text;
    t.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.style.display = 'none'; }, duration);
  }

  function setStatus(text) {
    el('status-line').textContent = text;
  }

  function shortId(id) {
    return id.length <= 8 ? id : id.slice(0, 6) + '\u2026';
  }

  // ─── View management ─────────────────────────────────────────────────────

  function showCallView(code) {
    hide('lobby');
    el('call-view').style.display = 'block';
    el('meeting-code-badge').textContent = code;
    if (localStream) el('local').srcObject = localStream;
    startTimer();
    updatePeerCount();
  }

  function showLobbyView() {
    hide('call-view');
    el('lobby').style.display = 'flex';
    stopTimer();
  }

  function startTimer() {
    timerSeconds = 0;
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      timerSeconds++;
      const m = Math.floor(timerSeconds / 60);
      const s = String(timerSeconds % 60).padStart(2, '0');
      el('call-timer').textContent = m + ':' + s;
    }, 1000);
  }

  function stopTimer() {
    clearInterval(timerInterval);
    timerInterval = null;
    el('call-timer').textContent = '0:00';
  }

  function updatePeerCount() {
    const n = peers.size + 1;
    el('peer-count').textContent = n === 1 ? '1 participant' : n + ' participants';
    updateVideoGrid();
  }

  function updateVideoGrid() {
    const container = el('remote-videos');
    const count = peers.size;

    if (count === 0) {
      showFlex('waiting-placeholder');
      container.style.gridTemplateColumns = '';
      container.style.gridTemplateRows = '';
      return;
    }

    hide('waiting-placeholder');

    let cols, rows;
    if (count === 1)      { cols = 1; rows = 1; }
    else if (count === 2) { cols = 2; rows = 1; }
    else if (count <= 4)  { cols = 2; rows = 2; }
    else if (count <= 6)  { cols = 3; rows = 2; }
    else if (count <= 9)  { cols = 3; rows = 3; }
    else                  { cols = 4; rows = Math.ceil(count / 4); }

    container.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
    container.style.gridTemplateRows    = 'repeat(' + rows + ', 1fr)';
  }

  // ─── Mic / Camera ─────────────────────────────────────────────────────────

  function syncMicUI() {
    const on = micEnabled;

    // Call view icons
    el('mic-icon-on').style.display = on ? '' : 'none';
    el('mic-icon-off').style.display = on ? 'none' : '';
    const micBtn = el('btn-mic');
    micBtn.classList.toggle('ctrl-btn--active', on);
    micBtn.classList.toggle('ctrl-btn--danger', !on);

    // Lobby icons
    el('lobby-mic-icon-on').style.display = on ? '' : 'none';
    el('lobby-mic-icon-off').style.display = on ? 'none' : '';
    const lobbyMicBtn = el('lobby-mic-btn');
    lobbyMicBtn.classList.toggle('ctrl-btn--active', on);
    lobbyMicBtn.classList.toggle('ctrl-btn--danger', !on);

    // PiP muted indicator
    el('pip-mic-off').style.display = on ? 'none' : '';
  }

  function syncCamUI() {
    const on = camEnabled;

    // Call view icons
    el('cam-icon-on').style.display = on ? '' : 'none';
    el('cam-icon-off').style.display = on ? 'none' : '';
    const camBtn = el('btn-cam');
    camBtn.classList.toggle('ctrl-btn--active', on);
    camBtn.classList.toggle('ctrl-btn--danger', !on);

    // Lobby icons
    el('lobby-cam-icon-on').style.display = on ? '' : 'none';
    el('lobby-cam-icon-off').style.display = on ? 'none' : '';
    const lobbyCamBtn = el('lobby-cam-btn');
    lobbyCamBtn.classList.toggle('ctrl-btn--active', on);
    lobbyCamBtn.classList.toggle('ctrl-btn--danger', !on);

    // PiP camera-off overlay
    el('pip-cam-off').style.display = on ? 'none' : 'flex';

    // Preview camera-off overlay
    el('preview-cam-off').style.display = on ? 'none' : 'flex';
  }

  function toggleMic() {
    if (!localStream) return;
    micEnabled = !micEnabled;
    for (const t of localStream.getAudioTracks()) t.enabled = micEnabled;
    syncMicUI();
    showToast(micEnabled ? 'Microphone on' : 'Microphone muted');
  }

  function toggleCam() {
    if (!localStream) return;
    camEnabled = !camEnabled;
    for (const t of localStream.getVideoTracks()) t.enabled = camEnabled;
    syncCamUI();
    showToast(camEnabled ? 'Camera on' : 'Camera off');
  }

  // ─── WebRTC helpers ───────────────────────────────────────────────────────

  function shouldInitiateOffer(remoteId) {
    return mySocketId.length > 0 && mySocketId < remoteId;
  }

  function removePeer(remoteId) {
    const state = peers.get(remoteId);
    if (state) {
      state.pc.close();
      state.videoBox.remove();
    }
    peers.delete(remoteId);
    preConnectIce.delete(remoteId);
    updatePeerCount();
  }

  function resetAllPeers() {
    for (const id of [...peers.keys()]) removePeer(id);
    preConnectIce.clear();
  }

  function flushPendingIce(state) {
    while (state.pendingIce.length > 0) {
      const c = state.pendingIce.shift();
      if (c) void state.pc.addIceCandidate(c).catch(() => {});
    }
  }

  /** @param {string} remoteId @returns {PeerState} */
  function ensurePeerState(remoteId) {
    let state = peers.get(remoteId);
    if (state) return state;

    const remoteRoot = el('remote-videos');

    const videoBox = document.createElement('div');
    videoBox.className = 'meet-tile';

    const video = document.createElement('video');
    video.playsInline = true;
    video.autoplay = true;
    video.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;transform:scaleX(-1)';

    const label = document.createElement('div');
    label.className = 'meet-tile-label';
    label.textContent = 'Peer ' + shortId(remoteId);

    videoBox.appendChild(video);
    videoBox.appendChild(label);
    remoteRoot.appendChild(videoBox);

    const pendingIce = /** @type {RTCIceCandidateInit[]} */ ([]);
    let remoteDescriptionReady = false;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    if (localStream) {
      for (const t of localStream.getTracks()) pc.addTrack(t, localStream);
    }
    pc.ontrack = (ev) => {
      const s = ev.streams[0];
      if (s) video.srcObject = s;
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate && socket?.connected) {
        socket.emit('webrtc:ice', { to: remoteId, candidate: ev.candidate.toJSON() });
      }
    };
    pc.onconnectionstatechange = () => {
      log('pc[' + shortId(remoteId) + '].connectionState', pc.connectionState);
    };

    state = { pc, pendingIce, remoteDescriptionReady, videoBox };
    peers.set(remoteId, state);

    const early = preConnectIce.get(remoteId);
    if (early) {
      for (const c of early) pendingIce.push(c);
      preConnectIce.delete(remoteId);
    }

    updatePeerCount();
    return state;
  }

  async function createAndSendOffer(remoteId) {
    await ensureStream();
    const state = ensurePeerState(remoteId);
    const offer = await state.pc.createOffer();
    await state.pc.setLocalDescription(offer);
    const sdp = state.pc.localDescription?.toJSON();
    if (sdp && socket?.connected) {
      socket.emit('webrtc:offer', { to: remoteId, sdp });
      log('sent offer \u2192', shortId(remoteId));
    }
  }

  // ─── Socket handlers ─────────────────────────────────────────────────────

  function registerSocketHandlers() {
    if (!socket) return;

    socket.off('connect');
    socket.off('connect_error');
    socket.off('disconnect');
    socket.off('meeting:peer-joined');
    socket.off('webrtc:offer');
    socket.off('webrtc:answer');
    socket.off('webrtc:ice');
    socket.off('meeting:peer-left');

    socket.on('connect', () => {
      mySocketId = socket.id;
      log('signaling connected', mySocketId);
    });

    socket.on('connect_error', (err) => {
      log('connect_error', err.message);
      setStatus('Connection failed: ' + err.message);
      showToast('Connection failed: ' + err.message);
      el('btn-connect').disabled = false;
    });

    socket.on('disconnect', (reason) => {
      log('signaling disconnected', reason);
      showToast('Disconnected from signaling server');
    });

    socket.on('meeting:peer-joined', (payload) => {
      if (!payload || typeof payload !== 'object') return;
      const peerId = payload.peerId;
      if (typeof peerId !== 'string' || peerId === mySocketId) return;
      log('meeting:peer-joined', shortId(peerId));
      showToast('Someone joined the call');
      if (shouldInitiateOffer(peerId)) {
        void createAndSendOffer(peerId).catch(e => log('offer error', String(e)));
      }
    });

    socket.on('webrtc:offer', async (msg) => {
      if (!msg || typeof msg !== 'object') return;
      const from = msg.from;
      if (typeof from !== 'string') return;
      if (!('sdp' in msg)) return;
      const sdpUnknown = msg.sdp;
      if (!sdpUnknown || typeof sdpUnknown !== 'object') return;

      const state = ensurePeerState(from);
      try {
        await state.pc.setRemoteDescription(/** @type {RTCSessionDescriptionInit} */ (sdpUnknown));
        state.remoteDescriptionReady = true;
        flushPendingIce(state);
        const answer = await state.pc.createAnswer();
        await state.pc.setLocalDescription(answer);
        const local = state.pc.localDescription?.toJSON();
        if (local && socket?.connected) {
          socket.emit('webrtc:answer', { to: from, sdp: local });
          log('sent answer \u2192', shortId(from));
        }
      } catch (e) {
        log('webrtc:offer error', String(e));
      }
    });

    socket.on('webrtc:answer', async (msg) => {
      if (!msg || typeof msg !== 'object') return;
      const from = msg.from;
      if (typeof from !== 'string') return;
      if (!('sdp' in msg)) return;
      const sdpUnknown = msg.sdp;
      if (!sdpUnknown || typeof sdpUnknown !== 'object') return;

      const state = peers.get(from);
      if (!state) return;
      try {
        await state.pc.setRemoteDescription(/** @type {RTCSessionDescriptionInit} */ (sdpUnknown));
        state.remoteDescriptionReady = true;
        flushPendingIce(state);
        log('set remote answer \u2190', shortId(from));
      } catch (e) {
        log('webrtc:answer error', String(e));
      }
    });

    socket.on('webrtc:ice', async (msg) => {
      if (!msg || typeof msg !== 'object') return;
      const from = msg.from;
      if (typeof from !== 'string') return;
      if (!('candidate' in msg)) return;
      const candidate = msg.candidate;
      if (!candidate || typeof candidate !== 'object') return;
      const init = /** @type {RTCIceCandidateInit} */ (candidate);

      const state = peers.get(from);
      if (!state) {
        if (!preConnectIce.has(from)) preConnectIce.set(from, []);
        preConnectIce.get(from)?.push(init);
        return;
      }
      if (!state.remoteDescriptionReady) {
        state.pendingIce.push(init);
        return;
      }
      try {
        await state.pc.addIceCandidate(init);
      } catch { /* ignore */ }
    });

    socket.on('meeting:peer-left', (payload) => {
      const peerId = payload && typeof payload === 'object' && 'peerId' in payload
        ? payload.peerId : undefined;
      if (typeof peerId === 'string') {
        log('meeting:peer-left', shortId(peerId));
        removePeer(peerId);
        showToast('A participant left the call');
      } else {
        log('meeting:peer-left (full reset)');
        resetAllPeers();
      }
    });
  }

  // ─── Connect / Leave ─────────────────────────────────────────────────────

  function defaultSignalingUrl() {
    const { hostname, protocol, port } = window.location;
    const isDefault = (protocol === 'https:' && (port === '' || port === '443'))
      || (protocol === 'http:' && (port === '' || port === '80'));
    return isDefault
      ? protocol + '//' + hostname
      : protocol + '//' + hostname + ':4002';
  }

  async function ensureStream() {
    if (localStream) return localStream;
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    for (const t of localStream.getAudioTracks()) t.enabled = micEnabled;
    for (const t of localStream.getVideoTracks()) t.enabled = camEnabled;
    const preview = document.getElementById('local-preview');
    if (preview) /** @type {HTMLVideoElement} */ (preview).srcObject = localStream;
    return localStream;
  }

  async function connect() {
    const token = window.localStorage.getItem(TOKEN_KEY);
    if (!token) {
      setStatus('Not signed in \u2014 log in on the dashboard first.');
      showToast('Sign in on the dashboard first');
      return;
    }

    const rawSignal = /** @type {HTMLInputElement} */ (el('input-signal')).value.trim();
    const signalBase = rawSignal.length > 0 ? rawSignal : defaultSignalingUrl();
    const code = /** @type {HTMLInputElement} */ (el('input-code')).value.trim();
    if (!code) {
      setStatus('Enter a meeting code.');
      return;
    }

    if (typeof io !== 'function') {
      setStatus('Socket.io failed to load (check network).');
      return;
    }

    el('btn-connect').disabled = true;
    setStatus('Connecting\u2026');
    el('log').textContent = '';
    mySocketId = '';
    resetAllPeers();

    try {
      await ensureStream();
    } catch (e) {
      setStatus('Camera or microphone unavailable.');
      log(String(e));
      el('btn-connect').disabled = false;
      return;
    }

    if (socket?.connected) socket.disconnect();

    socket = io(signalBase, {
      auth: { token },
      transports: ['websocket', 'polling'],
    });

    registerSocketHandlers();

    socket.emit('meeting:join', code, (ack) => {
      if (!ack || typeof ack !== 'object') {
        setStatus('Invalid join response');
        el('btn-connect').disabled = false;
        return;
      }
      if (!('ok' in ack) || ack.ok !== true) {
        const err = 'error' in ack && typeof ack.error === 'string' ? ack.error : 'Join failed';
        setStatus(err);
        showToast(err);
        log(ack);
        el('btn-connect').disabled = false;
        socket?.disconnect();
        return;
      }

      mySocketId = socket?.id ?? mySocketId;
      log('meeting:join ack', ack);

      const peerIds = 'peerIds' in ack && Array.isArray(ack.peerIds)
        ? ack.peerIds.filter(id => typeof id === 'string') : [];

      for (const pid of peerIds) {
        if (shouldInitiateOffer(pid)) {
          void createAndSendOffer(pid).catch(e => log('offer error', String(e)));
        }
      }

      showCallView(code);
      const n = typeof ack.peerCount === 'number' ? ack.peerCount : peerIds.length + 1;
      showToast(n <= 1 ? "You're the only one here" : n + ' people in this call');
    });
  }

  function leave() {
    socket?.emit('meeting:leave');
    socket?.disconnect();
    socket = null;
    mySocketId = '';
    resetAllPeers();
    el('btn-connect').disabled = false;
    showLobbyView();
    showToast('You left the call');
  }

  // ─── Init ─────────────────────────────────────────────────────────────────

  function initDefaults() {
    const params = new URLSearchParams(window.location.search);
    /** @type {HTMLInputElement} */ (el('input-signal')).value =
      params.get('signal') || defaultSignalingUrl();
    const code = params.get('code');
    if (code) /** @type {HTMLInputElement} */ (el('input-code')).value = code;
  }

  el('btn-connect').addEventListener('click', () => void connect());
  el('btn-leave').addEventListener('click', () => leave());
  el('btn-mic').addEventListener('click', () => toggleMic());
  el('btn-cam').addEventListener('click', () => toggleCam());
  el('lobby-mic-btn').addEventListener('click', () => toggleMic());
  el('lobby-cam-btn').addEventListener('click', () => toggleCam());

  // Shift+D toggles the debug log
  document.addEventListener('keydown', (e) => {
    if (e.key === 'D' && e.shiftKey) {
      const logEl = el('log');
      logEl.style.display = logEl.style.display === 'none' ? 'block' : 'none';
    }
  });

  // Auto-start lobby camera preview
  ensureStream().catch(() => {
    el('preview-cam-off').style.display = 'flex';
  });

  initDefaults();
})();
