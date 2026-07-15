'use strict';

const express = require('express');
const http = require('node:http');
const path = require('node:path');
const { Server } = require('socket.io');
const {
  createAttemptLimiter,
  createRateLimiter,
  generateToken,
  hashPin,
  hashToken,
  isOriginAllowed,
  normalizeHostId,
  normalizePermissions,
  normalizePin,
  parseAllowedOrigins,
  sanitizeLabel,
  validateControlEvent,
  validateSignalPayload,
  verifyPin,
  verifyToken,
} = require('./lib/security');

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT || 3000);
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;
const INVITE_TTL_MS = 2 * 60 * 1000;
const MAX_AUDIT_EVENTS = 200;
const allowedOrigins = parseAllowedOrigins(process.env.CORS_ORIGINS, { port: PORT });
const sessions = new Map();
const pinLimiter = createAttemptLimiter();
const controlLimiter = createRateLimiter({ maxEvents: 180, windowMs: 1000 });

const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      callback(null, isOriginAllowed(origin, allowedOrigins));
    },
    methods: ['GET', 'POST'],
  },
  allowRequest(req, callback) {
    callback(null, isOriginAllowed(req.headers.origin, allowedOrigins));
  },
  maxHttpBufferSize: 64 * 1024,
});

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(), display-capture=(self)');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'");
  next();
});
app.use(express.json({ limit: '16kb', strict: true }));
app.use(express.static(path.join(__dirname, 'public'), { fallthrough: true, index: 'index.html' }));

function getSession(hostId) {
  try {
    return sessions.get(normalizeHostId(hostId));
  } catch {
    return undefined;
  }
}

function hostView(hostId, session) {
  return Object.freeze({
    hostId,
    viewers: session.viewers.size,
    pendingViewers: session.pendingViewers.size,
    hasAgent: Boolean(session.agentSocketId),
    startedAt: session.startedAt,
  });
}

function audit(hostId, session, action, details = {}) {
  const safeDetails = {};
  for (const [key, value] of Object.entries(details)) {
    if (!/^[a-z][a-zA-Z0-9]{0,39}$/.test(key)) continue;
    safeDetails[key] = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160);
  }
  const event = Object.freeze({
    id: `${hostId}:${Date.now()}:${session.auditSequence += 1}`,
    action,
    at: new Date().toISOString(),
    details: Object.freeze(safeDetails),
  });
  session.audit.push(event);
  if (session.audit.length > MAX_AUDIT_EVENTS) session.audit.shift();
  if (session.hostSocketId) io.to(session.hostSocketId).emit('audit-event', event);
}

function endSession(hostId, session, reason = 'host-ended') {
  for (const viewerId of session.pendingViewers.keys()) io.to(viewerId).emit('viewer-denied', { reason: 'session-ended' });
  for (const viewerId of session.viewers.keys()) io.to(viewerId).emit('host-disconnected', { reason });
  if (session.agentSocketId) io.to(session.agentSocketId).emit('host-disconnected');
  sessions.delete(hostId);
}

function expireArtifacts(session, now = Date.now()) {
  for (const [digest, expiresAt] of session.inviteTokens) {
    if (expiresAt <= now) session.inviteTokens.delete(digest);
  }
  for (const [viewerId, pending] of session.pendingViewers) {
    if (pending.expiresAt <= now) {
      session.pendingViewers.delete(viewerId);
      io.to(viewerId).emit('viewer-denied', { reason: 'approval-expired' });
    }
  }
}

setInterval(() => {
  const now = Date.now();
  pinLimiter.sweep();
  for (const [hostId, session] of sessions) {
    expireArtifacts(session, now);
    if (now - session.updatedAt > SESSION_TTL_MS) endSession(hostId, session, 'expired');
  }
}, 60_000).unref();

app.get('/health', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, service: 'deskrtc-signaling', uptime: Math.floor(process.uptime()) });
});

app.post('/api/session/:hostId/verify-pin', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  let hostId;
  try {
    hostId = normalizeHostId(req.params.hostId);
  } catch {
    return res.status(400).json({ error: 'Invalid session request' });
  }

  const attemptKey = `${req.socket.remoteAddress || 'unknown'}:${hostId}`;
  const allowance = pinLimiter.check(attemptKey);
  if (!allowance.allowed) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(allowance.retryAfterMs / 1000))));
    return res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
  }

  const session = sessions.get(hostId);
  if (!session || !session.hostSocketId) return res.status(404).json({ error: 'Session not available' });
  expireArtifacts(session);

  if (!verifyPin(req.body?.pin, session.pinHash)) {
    pinLimiter.failure(attemptKey);
    audit(hostId, session, 'pin-rejected');
    return res.status(403).json({ error: 'Session ID or PIN is invalid' });
  }

  pinLimiter.success(attemptKey);
  const token = generateToken();
  session.inviteTokens.set(hashToken(token), Date.now() + INVITE_TTL_MS);
  session.updatedAt = Date.now();
  audit(hostId, session, 'pin-verified');
  return res.json({ ok: true, token, expiresInSeconds: Math.floor(INVITE_TTL_MS / 1000) });
});

io.on('connection', (socket) => {
  socket.on('register-host', (payload = {}) => {
    if (socket.role) return socket.emit('error-msg', 'Socket is already assigned to a session role');
    let hostId;
    let pin;
    try {
      hostId = normalizeHostId(payload.hostId);
      pin = normalizePin(payload.pin);
    } catch (error) {
      return socket.emit('error-msg', error.message);
    }
    if (sessions.has(hostId)) return socket.emit('error-msg', 'Session ID is already active');

    const agentToken = generateToken();
    const session = {
      hostSocketId: socket.id,
      agentSocketId: null,
      pendingViewers: new Map(),
      viewers: new Map(),
      inviteTokens: new Map(),
      pinHash: hashPin(pin),
      agentTokenHash: hashToken(agentToken),
      startedAt: Date.now(),
      updatedAt: Date.now(),
      audit: [],
      auditSequence: 0,
    };
    sessions.set(hostId, session);
    socket.hostId = hostId;
    socket.role = 'host';
    audit(hostId, session, 'host-registered');
    socket.emit('host-registered', { ...hostView(hostId, session), agentToken });
  });

  socket.on('register-agent', (payload = {}) => {
    if (socket.role) return socket.emit('error-msg', 'Socket is already assigned to a session role');
    const session = getSession(payload.hostId);
    if (!session || !session.hostSocketId || !verifyToken(payload.agentToken, session.agentTokenHash)) {
      return socket.emit('error-msg', 'Agent authorization failed');
    }
    if (session.agentSocketId && session.agentSocketId !== socket.id) {
      return socket.emit('error-msg', 'A host agent is already connected');
    }
    session.agentSocketId = socket.id;
    session.updatedAt = Date.now();
    socket.hostId = normalizeHostId(payload.hostId);
    socket.role = 'agent';
    audit(socket.hostId, session, 'agent-connected');
    io.to(session.hostSocketId).emit('agent-status', { connected: true });
    socket.emit('registered', { ok: true, hostId: socket.hostId });
  });

  socket.on('join-host', (payload = {}) => {
    if (socket.role) return socket.emit('error-msg', 'Socket is already assigned to a session role');
    let hostId;
    try {
      hostId = normalizeHostId(payload.hostId);
    } catch {
      return socket.emit('error-msg', 'Invalid session request');
    }
    const session = sessions.get(hostId);
    if (!session || !session.hostSocketId) return socket.emit('error-msg', 'Session not available');
    expireArtifacts(session);
    const digest = hashToken(payload.token);
    const expiresAt = session.inviteTokens.get(digest);
    if (!digest || !expiresAt || expiresAt <= Date.now()) return socket.emit('pin-required', { hostId });

    session.inviteTokens.delete(digest);
    const viewerLabel = sanitizeLabel(payload.viewerLabel, 'Viewer');
    const pending = Object.freeze({ viewerLabel, requestedAt: Date.now(), expiresAt: Date.now() + INVITE_TTL_MS });
    session.pendingViewers.set(socket.id, pending);
    session.updatedAt = Date.now();
    socket.hostId = hostId;
    socket.role = 'pending-viewer';
    socket.viewerLabel = viewerLabel;
    audit(hostId, session, 'viewer-requested', { viewer: viewerLabel });
    socket.emit('awaiting-host-approval', { hostId, expiresInSeconds: Math.floor(INVITE_TTL_MS / 1000) });
    io.to(session.hostSocketId).emit('viewer-request', { viewerId: socket.id, viewerLabel, requestedAt: pending.requestedAt });
  });

  socket.on('approve-viewer', (payload = {}) => {
    const session = getSession(socket.hostId);
    if (!session || socket.role !== 'host') return;
    const viewerId = String(payload.viewerId || '');
    const pending = session.pendingViewers.get(viewerId);
    if (!pending || pending.expiresAt <= Date.now()) return socket.emit('error-msg', 'Viewer request is no longer pending');
    const permissions = normalizePermissions(payload.permissions);
    session.pendingViewers.delete(viewerId);
    session.viewers.set(viewerId, Object.freeze({ viewerLabel: pending.viewerLabel, permissions, approvedAt: Date.now() }));
    session.updatedAt = Date.now();
    const viewerSocket = io.sockets.sockets.get(viewerId);
    if (viewerSocket) viewerSocket.role = 'viewer';
    audit(socket.hostId, session, 'viewer-approved', { viewer: pending.viewerLabel, permissions: JSON.stringify(permissions) });
    io.to(viewerId).emit('viewer-approved', { hostId: socket.hostId, permissions });
    io.to(session.hostSocketId).emit('client-joined', { viewerId, viewerLabel: pending.viewerLabel });
    io.to(session.hostSocketId).emit('viewer-count', session.viewers.size);
  });

  socket.on('deny-viewer', (payload = {}) => {
    const session = getSession(socket.hostId);
    if (!session || socket.role !== 'host') return;
    const viewerId = String(payload.viewerId || '');
    const pending = session.pendingViewers.get(viewerId);
    if (!pending) return;
    session.pendingViewers.delete(viewerId);
    audit(socket.hostId, session, 'viewer-denied', { viewer: pending.viewerLabel });
    io.to(viewerId).emit('viewer-denied', { reason: 'host-denied' });
  });

  socket.on('revoke-viewer', (payload = {}) => {
    const session = getSession(socket.hostId);
    if (!session || socket.role !== 'host') return;
    const viewerId = String(payload.viewerId || '');
    const viewer = session.viewers.get(viewerId);
    if (!viewer) return;
    session.viewers.delete(viewerId);
    controlLimiter.remove(viewerId);
    audit(socket.hostId, session, 'viewer-revoked', { viewer: viewer.viewerLabel });
    io.to(viewerId).emit('viewer-revoked');
    io.to(session.hostSocketId).emit('viewer-count', session.viewers.size);
  });

  socket.on('signal', (data = {}) => {
    const session = getSession(socket.hostId);
    if (!session) return;
    let signal;
    try {
      signal = validateSignalPayload(data);
    } catch {
      return socket.emit('error-msg', 'Invalid signaling payload');
    }
    session.updatedAt = Date.now();
    if (socket.role === 'host') {
      const targetId = String(data.targetId || '');
      if (!session.viewers.has(targetId)) return;
      io.to(targetId).emit('signal', { ...signal, fromId: socket.id });
    } else if (socket.role === 'viewer' && session.viewers.has(socket.id)) {
      io.to(session.hostSocketId).emit('signal', { ...signal, fromId: socket.id });
    }
  });

  socket.on('control-event', (rawEvent = {}) => {
    const session = getSession(socket.hostId);
    const viewer = session?.viewers.get(socket.id);
    if (!session || socket.role !== 'viewer' || !viewer || !session.agentSocketId) return;
    if (!controlLimiter.consume(socket.id)) return socket.emit('control-rejected', { reason: 'rate-limited' });
    let normalized;
    try {
      normalized = validateControlEvent(rawEvent);
    } catch {
      return socket.emit('control-rejected', { reason: 'invalid-event' });
    }
    if (viewer.permissions[normalized.capability] !== true) {
      return socket.emit('control-rejected', { reason: 'permission-denied', capability: normalized.capability });
    }
    io.to(session.agentSocketId).emit('control-event', normalized.event);
  });

  socket.on('chat-message', (message = {}) => {
    const session = getSession(socket.hostId);
    if (!session || !['host', 'viewer'].includes(socket.role)) return;
    if (socket.role === 'viewer' && !session.viewers.has(socket.id)) return;
    const packet = Object.freeze({
      text: String(message.text || '').replace(/[\u0000]/g, '').slice(0, 1000),
      from: socket.role,
      ts: Date.now(),
    });
    if (socket.role === 'host') {
      for (const viewerId of session.viewers.keys()) io.to(viewerId).emit('chat-message', packet);
    } else {
      io.to(session.hostSocketId).emit('chat-message', packet);
    }
  });

  socket.on('end-session', () => {
    const session = getSession(socket.hostId);
    if (!session || socket.role !== 'host') return;
    audit(socket.hostId, session, 'session-ended');
    endSession(socket.hostId, session);
  });

  socket.on('disconnect', () => {
    const session = getSession(socket.hostId);
    if (!session) return;
    if (socket.role === 'host') {
      endSession(socket.hostId, session, 'host-disconnected');
    } else if (socket.role === 'pending-viewer') {
      session.pendingViewers.delete(socket.id);
    } else if (socket.role === 'viewer') {
      session.viewers.delete(socket.id);
      controlLimiter.remove(socket.id);
      audit(socket.hostId, session, 'viewer-disconnected', { viewer: socket.viewerLabel || 'Viewer' });
      io.to(session.hostSocketId).emit('viewer-count', session.viewers.size);
    } else if (socket.role === 'agent') {
      session.agentSocketId = null;
      audit(socket.hostId, session, 'agent-disconnected');
      io.to(session.hostSocketId).emit('agent-status', { connected: false });
    }
  });
});

server.listen(PORT, BIND_HOST, () => {
  console.log(`DeskRTC signaling server listening on http://${BIND_HOST}:${PORT}`);
  console.log(`Allowed browser origins: ${allowedOrigins.join(', ')}`);
});
