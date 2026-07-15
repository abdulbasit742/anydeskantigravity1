'use strict';

const crypto = require('node:crypto');

const HOST_ID_PATTERN = /^\d{9,12}$/;
const PIN_PATTERN = /^\d{6,32}$/;
const ALLOWED_BUTTONS = new Set(['left', 'middle', 'right']);
const ALLOWED_SPECIAL_KEYS = new Set([
  'enter', 'backspace', 'tab', 'escape', 'space', 'arrowup', 'arrowdown',
  'arrowleft', 'arrowright', 'delete', 'pageup', 'pagedown', 'home', 'end',
  'insert', 'control', 'alt', 'shift', 'meta', 'f1', 'f2', 'f3', 'f4', 'f5',
  'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
]);
const MODIFIER_KEYS = new Set(['control', 'alt', 'shift', 'meta']);

function normalizeHostId(value) {
  const hostId = String(value ?? '').replace(/\D/g, '').slice(0, 12);
  if (!HOST_ID_PATTERN.test(hostId)) {
    throw new TypeError('hostId must contain 9 to 12 digits');
  }
  return hostId;
}

function normalizePin(value) {
  const pin = String(value ?? '').trim();
  if (!PIN_PATTERN.test(pin)) {
    throw new TypeError('PIN must contain 6 to 32 digits');
  }
  return pin;
}

function hashPin(value, salt = crypto.randomBytes(16)) {
  const pin = normalizePin(value);
  const normalizedSalt = Buffer.isBuffer(salt) ? salt : Buffer.from(String(salt), 'base64url');
  if (normalizedSalt.length < 16) throw new TypeError('PIN salt must be at least 16 bytes');
  const digest = crypto.scryptSync(pin, normalizedSalt, 32, { N: 16_384, r: 8, p: 1 });
  return `scrypt$${normalizedSalt.toString('base64url')}$${digest.toString('base64url')}`;
}

function verifyPin(value, storedHash) {
  let pin;
  try {
    pin = normalizePin(value);
  } catch {
    return false;
  }
  const [algorithm, encodedSalt, encodedDigest, extra] = String(storedHash ?? '').split('$');
  if (algorithm !== 'scrypt' || !encodedSalt || !encodedDigest || extra !== undefined) return false;
  try {
    const salt = Buffer.from(encodedSalt, 'base64url');
    const expected = Buffer.from(encodedDigest, 'base64url');
    const actual = crypto.scryptSync(pin, salt, expected.length, { N: 16_384, r: 8, p: 1 });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function generateToken(bytes = 32) {
  if (!Number.isInteger(bytes) || bytes < 24 || bytes > 64) {
    throw new RangeError('token size must be between 24 and 64 bytes');
  }
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashToken(value) {
  const token = String(value ?? '').trim();
  if (token.length < 32 || token.length > 128) return '';
  return crypto.createHash('sha256').update(token, 'utf8').digest('base64url');
}

function verifyToken(value, expectedDigest) {
  const actual = hashToken(value);
  const expected = String(expectedDigest ?? '');
  if (!actual || !expected) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function normalizeOrigin(value) {
  const input = String(value ?? '').trim();
  if (!input || input === '*') throw new TypeError('origin must be an explicit HTTP(S) origin');
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('origin must be an explicit HTTP(S) origin without credentials, path, query, or hash');
  }
  return url.origin;
}

function parseAllowedOrigins(value, { port = 3000 } = {}) {
  const entries = String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  const defaults = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
  return Object.freeze([...new Set((entries.length ? entries : defaults).map(normalizeOrigin))]);
}

function isOriginAllowed(origin, allowedOrigins) {
  if (!origin) return true;
  let normalized;
  try {
    normalized = normalizeOrigin(origin);
  } catch {
    return false;
  }
  return allowedOrigins.includes(normalized);
}

function sanitizeLabel(value, fallback = 'Viewer') {
  const label = String(value ?? '').normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return (label || fallback).slice(0, 80);
}

function normalizePermissions(value = {}) {
  return Object.freeze({
    screen: true,
    pointer: value.pointer === true,
    keyboard: value.keyboard === true,
    clipboard: value.clipboard === true,
  });
}

function normalizeKey(value) {
  const key = String(value ?? '').normalize('NFKC').toLowerCase();
  if (ALLOWED_SPECIAL_KEYS.has(key)) return key;
  if ([...key].length === 1 && !/[\u0000-\u001f\u007f]/.test(key)) return key;
  return '';
}

function validateControlEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('control event must be an object');
  }
  const type = String(value.type ?? '');
  if (type === 'move') {
    const x = Number(value.x);
    const y = Number(value.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
      throw new TypeError('pointer coordinates must be between 0 and 1');
    }
    return Object.freeze({ capability: 'pointer', event: Object.freeze({ type, x, y }) });
  }
  if (type === 'click') {
    const button = String(value.button ?? 'left').toLowerCase();
    if (!ALLOWED_BUTTONS.has(button)) throw new TypeError('unsupported pointer button');
    return Object.freeze({ capability: 'pointer', event: Object.freeze({ type, button }) });
  }
  if (type === 'scroll') {
    const delta = Number(value.delta);
    if (!Number.isInteger(delta) || delta < -100 || delta > 100) {
      throw new TypeError('scroll delta must be an integer between -100 and 100');
    }
    return Object.freeze({ capability: 'pointer', event: Object.freeze({ type, delta }) });
  }
  if (type === 'key') {
    const key = normalizeKey(value.key);
    if (!key) throw new TypeError('unsupported keyboard key');
    return Object.freeze({ capability: 'keyboard', event: Object.freeze({ type, key }) });
  }
  if (type === 'hotkey') {
    if (!Array.isArray(value.keys) || value.keys.length < 2 || value.keys.length > 4) {
      throw new TypeError('hotkey must contain two to four keys');
    }
    const keys = value.keys.map(normalizeKey);
    if (keys.some((key) => !key) || !keys.some((key) => MODIFIER_KEYS.has(key))) {
      throw new TypeError('hotkey must contain supported keys and a modifier');
    }
    return Object.freeze({ capability: 'keyboard', event: Object.freeze({ type, keys: Object.freeze(keys) }) });
  }
  if (type === 'clipboard') {
    const text = String(value.text ?? '');
    if (text.length > 4096 || /[\u0000]/.test(text)) throw new TypeError('clipboard text is invalid or too large');
    return Object.freeze({ capability: 'clipboard', event: Object.freeze({ type, text }) });
  }
  throw new TypeError('unsupported control event type');
}

function validateSignalPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('signal payload must be an object');
  }
  const output = {};
  if (value.description !== undefined) {
    const description = value.description;
    if (!description || typeof description !== 'object' || Array.isArray(description)) {
      throw new TypeError('signal description must be an object');
    }
    const type = String(description.type ?? '');
    const sdp = String(description.sdp ?? '');
    if (!['offer', 'answer'].includes(type) || !sdp || sdp.length > 32_768 || /[\u0000]/.test(sdp)) {
      throw new TypeError('signal description is invalid or too large');
    }
    output.description = Object.freeze({ type, sdp });
  }
  if (value.candidate !== undefined) {
    const candidate = value.candidate;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new TypeError('ICE candidate must be an object');
    }
    const candidateText = String(candidate.candidate ?? '');
    const sdpMid = candidate.sdpMid === null || candidate.sdpMid === undefined ? null : String(candidate.sdpMid).slice(0, 64);
    const sdpMLineIndex = candidate.sdpMLineIndex === null || candidate.sdpMLineIndex === undefined
      ? null
      : Number(candidate.sdpMLineIndex);
    const usernameFragment = candidate.usernameFragment === null || candidate.usernameFragment === undefined
      ? null
      : String(candidate.usernameFragment).slice(0, 256);
    if (!candidateText || candidateText.length > 2_048 || /[\u0000]/.test(candidateText)) {
      throw new TypeError('ICE candidate is invalid or too large');
    }
    if (sdpMLineIndex !== null && (!Number.isInteger(sdpMLineIndex) || sdpMLineIndex < 0 || sdpMLineIndex > 32)) {
      throw new TypeError('ICE candidate line index is invalid');
    }
    output.candidate = Object.freeze({ candidate: candidateText, sdpMid, sdpMLineIndex, usernameFragment });
  }
  if (!output.description && !output.candidate) throw new TypeError('signal payload is empty');
  return Object.freeze(output);
}

function createAttemptLimiter({ maxFailures = 5, windowMs = 5 * 60_000, blockMs = 15 * 60_000, now = Date.now } = {}) {
  const records = new Map();
  function getRecord(key) {
    const timestamp = now();
    const existing = records.get(key);
    if (!existing || timestamp - existing.windowStartedAt >= windowMs) {
      const record = { failures: 0, windowStartedAt: timestamp, blockedUntil: 0 };
      records.set(key, record);
      return record;
    }
    return existing;
  }
  return Object.freeze({
    check(key) {
      const record = getRecord(key);
      const remaining = record.blockedUntil - now();
      return Object.freeze({ allowed: remaining <= 0, retryAfterMs: Math.max(0, remaining) });
    },
    failure(key) {
      const record = getRecord(key);
      record.failures += 1;
      if (record.failures >= maxFailures) record.blockedUntil = now() + blockMs;
      return this.check(key);
    },
    success(key) {
      records.delete(key);
    },
    sweep() {
      const timestamp = now();
      for (const [key, record] of records) {
        if (timestamp > Math.max(record.blockedUntil, record.windowStartedAt + windowMs) + windowMs) records.delete(key);
      }
    },
    size() {
      return records.size;
    },
  });
}

function createRateLimiter({ maxEvents = 180, windowMs = 1000, now = Date.now } = {}) {
  const records = new Map();
  return Object.freeze({
    consume(key) {
      const timestamp = now();
      let record = records.get(key);
      if (!record || timestamp - record.startedAt >= windowMs) {
        record = { startedAt: timestamp, count: 0 };
        records.set(key, record);
      }
      record.count += 1;
      return record.count <= maxEvents;
    },
    remove(key) {
      records.delete(key);
    },
  });
}

module.exports = {
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
};
