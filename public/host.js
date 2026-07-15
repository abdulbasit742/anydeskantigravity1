'use strict';

const socket = io({ transports: ['websocket', 'polling'] });
const hostIdInput = document.getElementById('hostId');
const pinInput = document.getElementById('pin');
const startBtn = document.getElementById('startBtn');
const agentBtn = document.getElementById('agentBtn');
const stopAgentBtn = document.getElementById('stopAgentBtn');
const endBtn = document.getElementById('endBtn');
const statusEl = document.getElementById('status');
const preview = document.getElementById('preview');
const pendingList = document.getElementById('pendingList');
const viewerList = document.getElementById('viewerList');
const agentHelp = document.getElementById('agentHelp');
const peers = new Map();
const pendingRows = new Map();
const viewerRows = new Map();
let stream;
let agentToken = '';
let sessionStarted = false;

function secureDigits(length) {
  const values = new Uint32Array(length);
  crypto.getRandomValues(values);
  return [...values].map((value) => String(value % 10)).join('');
}

hostIdInput.value = `1${secureDigits(8)}`;
pinInput.value = secureDigits(6);

function log(message) {
  statusEl.textContent = `[${new Date().toLocaleTimeString()}] ${String(message).slice(0, 240)}\n${statusEl.textContent}`;
}

function updateEmptyState(container, rows, message) {
  const existing = container.querySelector('.empty-state');
  if (rows.size === 0 && !existing) {
    const paragraph = document.createElement('p');
    paragraph.className = 'empty-state';
    paragraph.textContent = message;
    container.append(paragraph);
  } else if (rows.size > 0 && existing) {
    existing.remove();
  }
}

function permissionControl(labelText, checked = false) {
  const label = document.createElement('label');
  label.className = 'check compact-check';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  label.append(input, document.createTextNode(labelText));
  return { label, input };
}

function renderPending({ viewerId, viewerLabel }) {
  if (pendingRows.has(viewerId)) return;
  const row = document.createElement('article');
  row.className = 'request-item';
  const heading = document.createElement('h3');
  heading.textContent = viewerLabel;
  const note = document.createElement('p');
  note.textContent = 'PIN verified. Select only the capabilities needed, then approve or deny this viewer.';

  const pointer = permissionControl('Pointer control');
  const keyboard = permissionControl('Keyboard input');
  const clipboard = permissionControl('Clipboard write');
  const permissions = document.createElement('div');
  permissions.className = 'permission-options';
  permissions.append(pointer.label, keyboard.label, clipboard.label);

  const actions = document.createElement('div');
  actions.className = 'actions compact-actions';
  const approve = document.createElement('button');
  approve.type = 'button';
  approve.className = 'button';
  approve.textContent = 'Approve viewer';
  approve.addEventListener('click', () => {
    socket.emit('approve-viewer', {
      viewerId,
      permissions: {
        pointer: pointer.input.checked,
        keyboard: keyboard.input.checked,
        clipboard: clipboard.input.checked,
      },
    });
    row.remove();
    pendingRows.delete(viewerId);
    updateEmptyState(pendingList, pendingRows, 'No pending viewers.');
  });

  const deny = document.createElement('button');
  deny.type = 'button';
  deny.className = 'button danger';
  deny.textContent = 'Deny';
  deny.addEventListener('click', () => {
    socket.emit('deny-viewer', { viewerId });
    row.remove();
    pendingRows.delete(viewerId);
    updateEmptyState(pendingList, pendingRows, 'No pending viewers.');
    log(`Denied viewer ${viewerLabel}.`);
  });

  actions.append(approve, deny);
  row.append(heading, note, permissions, actions);
  pendingRows.set(viewerId, row);
  pendingList.append(row);
  updateEmptyState(pendingList, pendingRows, 'No pending viewers.');
  log(`Viewer request received from ${viewerLabel}.`);
}

function renderApproved({ viewerId, viewerLabel }) {
  if (viewerRows.has(viewerId)) return;
  const row = document.createElement('article');
  row.className = 'request-item';
  const heading = document.createElement('h3');
  heading.textContent = viewerLabel;
  const note = document.createElement('p');
  note.textContent = 'Approved for this session. You can revoke access immediately.';
  const revoke = document.createElement('button');
  revoke.type = 'button';
  revoke.className = 'button danger';
  revoke.textContent = 'Revoke viewer';
  revoke.addEventListener('click', () => {
    socket.emit('revoke-viewer', { viewerId });
    peers.get(viewerId)?.close();
    peers.delete(viewerId);
    row.remove();
    viewerRows.delete(viewerId);
    updateEmptyState(viewerList, viewerRows, 'No approved viewers.');
    log(`Revoked viewer ${viewerLabel}.`);
  });
  row.append(heading, note, revoke);
  viewerRows.set(viewerId, row);
  viewerList.append(row);
  updateEmptyState(viewerList, viewerRows, 'No approved viewers.');
}

async function makePeer(viewerId) {
  if (!stream || peers.has(viewerId)) return peers.get(viewerId);
  const pc = new RTCPeerConnection({ iceServers: [] });
  stream.getTracks().forEach((track) => pc.addTrack(track, stream));
  pc.onicecandidate = (event) => {
    if (event.candidate) socket.emit('signal', { targetId: viewerId, candidate: event.candidate });
  };
  pc.onconnectionstatechange = () => log(`Viewer connection state: ${pc.connectionState}.`);
  peers.set(viewerId, pc);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('signal', { targetId: viewerId, description: pc.localDescription });
  return pc;
}

async function endSession() {
  if (!sessionStarted) return;
  socket.emit('end-session');
  sessionStarted = false;
  for (const pc of peers.values()) pc.close();
  peers.clear();
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  if (window.deskRTC) await window.deskRTC.stopAgent().catch(() => {});
  agentToken = '';
  startBtn.disabled = true;
  agentBtn.disabled = true;
  stopAgentBtn.disabled = true;
  endBtn.disabled = true;
  log('Session ended. Refresh the page to create a new session.');
}

startBtn.addEventListener('click', async () => {
  if (!/^\d{6,32}$/.test(pinInput.value.trim())) {
    log('PIN must contain 6 to 32 digits.');
    pinInput.focus();
    return;
  }
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    preview.srcObject = stream;
    stream.getVideoTracks()[0]?.addEventListener('ended', () => endSession());
    socket.emit('register-host', { hostId: hostIdInput.value, pin: pinInput.value.trim() });
    startBtn.disabled = true;
    pinInput.disabled = true;
    endBtn.disabled = false;
    log('Screen selected. Waiting for server registration.');
  } catch (error) {
    log(error?.name === 'NotAllowedError' ? 'Screen sharing was cancelled.' : 'Could not start screen sharing.');
  }
});

agentBtn.addEventListener('click', async () => {
  if (!window.deskRTC || !agentToken) return;
  try {
    await window.deskRTC.startAgent(hostIdInput.value, agentToken);
    agentBtn.disabled = true;
    stopAgentBtn.disabled = false;
    log('Local control agent start requested.');
  } catch {
    log('Local control agent could not be started.');
  }
});

stopAgentBtn.addEventListener('click', async () => {
  if (!window.deskRTC) return;
  await window.deskRTC.stopAgent().catch(() => {});
  stopAgentBtn.disabled = true;
  agentBtn.disabled = !agentToken;
  log('Local control agent stopped.');
});

endBtn.addEventListener('click', () => endSession());

socket.on('host-registered', (data) => {
  sessionStarted = true;
  agentToken = String(data.agentToken || '');
  agentBtn.disabled = !window.deskRTC || !agentToken;
  if (!window.deskRTC) agentHelp.textContent = 'Remote input is disabled in the browser host. Use the Electron host app to run the authenticated local agent.';
  log(`Host registered. Session ID ${data.hostId}; no viewer is admitted without approval.`);
});
socket.on('viewer-request', renderPending);
socket.on('client-joined', async (data) => {
  renderApproved(data);
  try {
    await makePeer(data.viewerId);
  } catch {
    log(`Could not create a screen connection for ${data.viewerLabel}.`);
  }
});
socket.on('viewer-count', (count) => log(`Approved viewer count: ${count}.`));
socket.on('agent-status', (data) => {
  agentBtn.disabled = Boolean(data.connected) || !agentToken || !window.deskRTC;
  stopAgentBtn.disabled = !data.connected;
  log(`Local agent ${data.connected ? 'connected' : 'disconnected'}.`);
});
socket.on('audit-event', (event) => log(`Audit: ${event.action}.`));
socket.on('error-msg', (message) => log(message));

if (window.deskRTC) {
  window.deskRTC.onAgentLog((text) => log(text));
  window.deskRTC.onAgentExit(({ code }) => {
    agentBtn.disabled = !agentToken;
    stopAgentBtn.disabled = true;
    log(`Local agent exited${code === null ? '' : ` with code ${code}`}.`);
  });
}
