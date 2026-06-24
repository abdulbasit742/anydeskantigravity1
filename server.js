const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN || '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 10 * 1024 * 1024
});

const PORT = Number(process.env.PORT || 3000);
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;
const sessions = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function cleanId(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 12);
}

function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}

function publicSession(hostId, session) {
  return {
    hostId,
    hasHost: Boolean(session.hostSocketId),
    viewers: session.viewers.size,
    hasAgent: Boolean(session.agentSocketId),
    hasPin: Boolean(session.pin),
    allowControl: Boolean(session.allowControl),
    startedAt: session.startedAt
  };
}

function getSession(hostId) {
  return sessions.get(cleanId(hostId));
}

setInterval(() => {
  const now = Date.now();
  for (const [hostId, session] of sessions.entries()) {
    if (now - session.updatedAt > SESSION_TTL_MS) sessions.delete(hostId);
  }
}, 10 * 60 * 1000).unref();

app.get('/health', (_req, res) => {
  res.json({ ok: true, sessions: sessions.size, uptime: Math.floor(process.uptime()) });
});

app.get('/api/sessions', (_req, res) => {
  res.json([...sessions.entries()].map(([id, session]) => publicSession(id, session)));
});

app.post('/api/session/:hostId/verify-pin', (req, res) => {
  const hostId = cleanId(req.params.hostId);
  const session = sessions.get(hostId);
  if (!session || !session.hostSocketId) return res.status(404).json({ error: 'Host session not found' });
  if (!session.pin) return res.status(403).json({ error: 'Host has not configured a PIN' });
  if (String(req.body.pin || '') !== session.pin) return res.status(403).json({ error: 'Invalid PIN' });

  const token = makeToken();
  session.tokens.add(token);
  session.updatedAt = Date.now();
  setTimeout(() => session.tokens.delete(token), 2 * 60 * 1000).unref();
  res.json({ ok: true, token });
});

io.on('connection', (socket) => {
  socket.on('register-host', ({ hostId, pin, allowControl } = {}) => {
    const id = cleanId(hostId);
    if (!id) return socket.emit('error-msg', 'Missing host ID');
    if (!pin || String(pin).length < 4) return socket.emit('error-msg', 'A session PIN of at least 4 digits is required');

    const session = {
      hostSocketId: socket.id,
      agentSocketId: null,
      viewers: new Set(),
      tokens: new Set(),
      pin: String(pin).slice(0, 32),
      allowControl: Boolean(allowControl),
      startedAt: Date.now(),
      updatedAt: Date.now()
    };
    sessions.set(id, session);
    socket.hostId = id;
    socket.role = 'host';
    socket.emit('host-registered', publicSession(id, session));
  });

  socket.on('update-host-settings', ({ allowControl } = {}) => {
    const session = getSession(socket.hostId);
    if (!session || socket.role !== 'host') return;
    session.allowControl = Boolean(allowControl);
    session.updatedAt = Date.now();
    for (const viewerId of session.viewers) io.to(viewerId).emit('host-settings', { allowControl: session.allowControl });
  });

  socket.on('register-agent', ({ hostId } = {}) => {
    const id = cleanId(hostId || socket.hostId);
    const session = sessions.get(id);
    if (!session || !session.hostSocketId) return socket.emit('error-msg', 'Host must start first before agent can register');
    session.agentSocketId = socket.id;
    session.updatedAt = Date.now();
    socket.hostId = id;
    socket.role = 'agent';
    io.to(session.hostSocketId).emit('agent-status', { connected: true });
    socket.emit('registered', { ok: true, hostId: id });
  });

  socket.on('join-host', ({ hostId, token } = {}) => {
    const id = cleanId(hostId);
    const session = sessions.get(id);
    if (!session || !session.hostSocketId) return socket.emit('error-msg', 'Host not found');
    if (!token || !session.tokens.has(token)) return socket.emit('pin-required', { hostId: id });
    session.tokens.delete(token);
    session.viewers.add(socket.id);
    session.updatedAt = Date.now();
    socket.hostId = id;
    socket.role = 'viewer';
    socket.emit('viewer-joined', { hostId: id, allowControl: session.allowControl });
    io.to(session.hostSocketId).emit('client-joined', { viewerId: socket.id });
    io.to(session.hostSocketId).emit('viewer-count', session.viewers.size);
  });

  socket.on('signal', (data = {}) => {
    const session = getSession(socket.hostId);
    if (!session) return;
    session.updatedAt = Date.now();
    if (socket.role === 'host') {
      const target = data.targetId || [...session.viewers][0];
      if (target) io.to(target).emit('signal', { ...data, fromId: socket.id });
    } else if (socket.role === 'viewer') {
      io.to(session.hostSocketId).emit('signal', { ...data, fromId: socket.id });
    }
  });

  socket.on('control-event', (event = {}) => {
    const session = getSession(socket.hostId);
    if (!session || socket.role !== 'viewer') return;
    if (!session.allowControl || !session.agentSocketId) return;
    io.to(session.agentSocketId).emit('control-event', event);
  });

  socket.on('chat-message', (message = {}) => {
    const session = getSession(socket.hostId);
    if (!session || !['host', 'viewer'].includes(socket.role)) return;
    const packet = { text: String(message.text || '').slice(0, 1000), from: socket.role, ts: Date.now() };
    if (socket.role === 'host') {
      for (const viewerId of session.viewers) io.to(viewerId).emit('chat-message', packet);
    } else {
      io.to(session.hostSocketId).emit('chat-message', packet);
    }
  });

  socket.on('disconnect', () => {
    const session = getSession(socket.hostId);
    if (!session) return;
    if (socket.role === 'host') {
      for (const viewerId of session.viewers) io.to(viewerId).emit('host-disconnected');
      if (session.agentSocketId) io.to(session.agentSocketId).emit('host-disconnected');
      sessions.delete(socket.hostId);
    } else if (socket.role === 'viewer') {
      session.viewers.delete(socket.id);
      io.to(session.hostSocketId).emit('viewer-count', session.viewers.size);
    } else if (socket.role === 'agent') {
      session.agentSocketId = null;
      io.to(session.hostSocketId).emit('agent-status', { connected: false });
    }
  });
});

server.listen(PORT, () => {
  console.log(`DeskRTC server running at http://localhost:${PORT}`);
});
