'use strict';

const socket = io({ transports: ['websocket', 'polling'] });
const viewerLabelInput = document.getElementById('viewerLabel');
const hostIdInput = document.getElementById('hostId');
const pinInput = document.getElementById('pin');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const statusEl = document.getElementById('status');
const permissionsEl = document.getElementById('permissions');
const video = document.getElementById('remoteVideo');
const clipboardText = document.getElementById('clipboardText');
const clipboardBtn = document.getElementById('clipboardBtn');
let pc;
let permissions = Object.freeze({ screen: false, pointer: false, keyboard: false, clipboard: false });
let connected = false;
let pendingMove = null;
let moveFrame = 0;

function log(message) {
  statusEl.textContent = `[${new Date().toLocaleTimeString()}] ${String(message).slice(0, 240)}\n${statusEl.textContent}`;
}

function renderPermissions() {
  const granted = Object.entries(permissions).filter(([, allowed]) => allowed).map(([name]) => name);
  permissionsEl.textContent = granted.length ? `Host-approved capabilities: ${granted.join(', ')}.` : 'No permissions granted.';
  clipboardText.disabled = !permissions.clipboard;
  clipboardBtn.disabled = !permissions.clipboard;
}

function closeConnection(reason) {
  connected = false;
  permissions = Object.freeze({ screen: false, pointer: false, keyboard: false, clipboard: false });
  renderPermissions();
  if (pc) pc.close();
  pc = null;
  video.srcObject = null;
  connectBtn.disabled = true;
  disconnectBtn.disabled = true;
  log(reason);
}

function createPeer() {
  if (pc) return pc;
  pc = new RTCPeerConnection({ iceServers: [] });
  pc.ontrack = (event) => {
    video.srcObject = event.streams[0];
    log('Approved screen stream received.');
  };
  pc.onicecandidate = (event) => {
    if (event.candidate) socket.emit('signal', { candidate: event.candidate });
  };
  pc.onconnectionstatechange = () => {
    log(`Connection state: ${pc.connectionState}.`);
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) connected = false;
  };
  return pc;
}

async function verifyPin(hostId, pin) {
  const response = await fetch(`/api/session/${encodeURIComponent(hostId)}/verify-pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ pin }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'PIN verification failed');
  return data.token;
}

async function requestAccess() {
  const hostId = hostIdInput.value.replace(/\D/g, '').slice(0, 12);
  const pin = pinInput.value.trim();
  const viewerLabel = viewerLabelInput.value.trim();
  if (!/^\d{9,12}$/.test(hostId) || !/^\d{6,32}$/.test(pin) || !viewerLabel) {
    log('Enter a viewer label, a 9–12 digit session ID, and a 6+ digit PIN.');
    return;
  }
  connectBtn.disabled = true;
  try {
    const token = await verifyPin(hostId, pin);
    createPeer();
    socket.emit('join-host', { hostId, token, viewerLabel });
    pinInput.value = '';
    log('PIN verified. Waiting for explicit host approval.');
  } catch (error) {
    connectBtn.disabled = false;
    log(error.message);
  }
}

function sendControl(event, capability) {
  if (!connected || permissions[capability] !== true) return;
  socket.emit('control-event', event);
}

connectBtn.addEventListener('click', () => requestAccess());
disconnectBtn.addEventListener('click', () => {
  socket.disconnect();
  closeConnection('Viewer disconnected. Refresh the page to request another session.');
});

video.addEventListener('pointerdown', () => video.focus());
video.addEventListener('mousemove', (event) => {
  if (!permissions.pointer || document.activeElement !== video) return;
  const box = video.getBoundingClientRect();
  pendingMove = { type: 'move', x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height };
  if (!moveFrame) {
    moveFrame = requestAnimationFrame(() => {
      moveFrame = 0;
      if (pendingMove) sendControl(pendingMove, 'pointer');
      pendingMove = null;
    });
  }
});
video.addEventListener('click', () => sendControl({ type: 'click', button: 'left' }, 'pointer'));
video.addEventListener('contextmenu', (event) => {
  if (!permissions.pointer) return;
  event.preventDefault();
  sendControl({ type: 'click', button: 'right' }, 'pointer');
});
video.addEventListener('wheel', (event) => {
  if (!permissions.pointer || document.activeElement !== video) return;
  event.preventDefault();
  sendControl({ type: 'scroll', delta: event.deltaY < 0 ? 5 : -5 }, 'pointer');
}, { passive: false });
video.addEventListener('keydown', (event) => {
  if (!permissions.keyboard) return;
  event.preventDefault();
  const modifiers = [];
  if (event.ctrlKey) modifiers.push('control');
  if (event.altKey) modifiers.push('alt');
  if (event.shiftKey) modifiers.push('shift');
  if (event.metaKey) modifiers.push('meta');
  if (modifiers.length && !['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) {
    sendControl({ type: 'hotkey', keys: [...modifiers, event.key] }, 'keyboard');
  } else {
    sendControl({ type: 'key', key: event.key }, 'keyboard');
  }
});
clipboardBtn.addEventListener('click', () => {
  sendControl({ type: 'clipboard', text: clipboardText.value }, 'clipboard');
  clipboardText.value = '';
  log('Clipboard text sent under the approved clipboard scope.');
});

socket.on('awaiting-host-approval', (data) => log(`Host approval requested. Request expires in ${data.expiresInSeconds} seconds.`));
socket.on('viewer-approved', (data) => {
  permissions = Object.freeze({ ...data.permissions });
  connected = true;
  disconnectBtn.disabled = false;
  renderPermissions();
  log('Host approved this viewer. Waiting for the screen offer.');
});
socket.on('viewer-denied', (data) => closeConnection(`Access denied: ${data.reason}.`));
socket.on('viewer-revoked', () => closeConnection('The host revoked this viewer.'));
socket.on('host-disconnected', () => closeConnection('The host ended or disconnected the session.'));
socket.on('pin-required', () => {
  connectBtn.disabled = false;
  log('The invitation expired. Verify the PIN again.');
});
socket.on('control-rejected', (data) => log(`Control event rejected: ${data.reason}.`));
socket.on('error-msg', (message) => {
  connectBtn.disabled = false;
  log(message);
});
socket.on('signal', async (data) => {
  try {
    const peer = createPeer();
    if (data.description) {
      await peer.setRemoteDescription(data.description);
      if (data.description.type === 'offer') {
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        socket.emit('signal', { description: peer.localDescription });
      }
    }
    if (data.candidate) await peer.addIceCandidate(data.candidate);
  } catch {
    log('The WebRTC negotiation failed.');
  }
});

renderPermissions();
