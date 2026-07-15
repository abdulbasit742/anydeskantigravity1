'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
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
} = require('../lib/security');

test('normalizes a valid numeric host ID', () => {
  assert.equal(normalizeHostId('123-456-789'), '123456789');
});

test('rejects short or empty host IDs', () => {
  assert.throws(() => normalizeHostId('1234'), /9 to 12 digits/);
  assert.throws(() => normalizeHostId(''), /9 to 12 digits/);
});

test('requires a six-digit-or-longer numeric PIN', () => {
  assert.equal(normalizePin('123456'), '123456');
  assert.throws(() => normalizePin('1234'), /6 to 32 digits/);
  assert.throws(() => normalizePin('12345x'), /6 to 32 digits/);
});

test('stores PINs as salted scrypt hashes and verifies in constant-time form', () => {
  const stored = hashPin('123456', Buffer.alloc(16, 7));
  assert.match(stored, /^scrypt\$/);
  assert.equal(stored.includes('123456'), false);
  assert.equal(verifyPin('123456', stored), true);
  assert.equal(verifyPin('654321', stored), false);
  assert.equal(verifyPin('bad', stored), false);
});

test('creates opaque tokens and verifies only matching digests', () => {
  const token = generateToken();
  const digest = hashToken(token);
  assert.ok(token.length >= 32);
  assert.equal(verifyToken(token, digest), true);
  assert.equal(verifyToken(`${token}x`, digest), false);
  assert.equal(hashToken('short'), '');
});

test('uses explicit local origins by default and rejects wildcard origins', () => {
  assert.deepEqual(parseAllowedOrigins('', { port: 5000 }), ['http://localhost:5000', 'http://127.0.0.1:5000']);
  assert.throws(() => parseAllowedOrigins('*'), /explicit HTTP/);
  assert.throws(() => parseAllowedOrigins('https://example.com/path'), /without credentials/);
});

test('allows configured browser origins and origin-less native clients only', () => {
  const origins = parseAllowedOrigins('https://support.example.com');
  assert.equal(isOriginAllowed('https://support.example.com', origins), true);
  assert.equal(isOriginAllowed('https://evil.example.com', origins), false);
  assert.equal(isOriginAllowed(undefined, origins), true);
});

test('normalizes viewer permissions with screen view always enabled', () => {
  assert.deepEqual(normalizePermissions({ pointer: true, keyboard: false, clipboard: true }), {
    screen: true, pointer: true, keyboard: false, clipboard: true,
  });
});

test('validates and minimizes pointer events', () => {
  assert.deepEqual(validateControlEvent({ type: 'move', x: 0.25, y: 0.75, ignored: 'x' }), {
    capability: 'pointer', event: { type: 'move', x: 0.25, y: 0.75 },
  });
  assert.deepEqual(validateControlEvent({ type: 'click', button: 'right' }), {
    capability: 'pointer', event: { type: 'click', button: 'right' },
  });
  assert.throws(() => validateControlEvent({ type: 'move', x: -1, y: 0 }), /between 0 and 1/);
  assert.throws(() => validateControlEvent({ type: 'click', button: 'side' }), /unsupported/);
});

test('bounds scrolling and rejects fractional or excessive deltas', () => {
  assert.deepEqual(validateControlEvent({ type: 'scroll', delta: -5 }), {
    capability: 'pointer', event: { type: 'scroll', delta: -5 },
  });
  assert.throws(() => validateControlEvent({ type: 'scroll', delta: 1000 }), /between -100 and 100/);
  assert.throws(() => validateControlEvent({ type: 'scroll', delta: 1.5 }), /integer/);
});

test('allows known keyboard keys and bounded modifier hotkeys', () => {
  assert.deepEqual(validateControlEvent({ type: 'key', key: 'Enter' }), {
    capability: 'keyboard', event: { type: 'key', key: 'enter' },
  });
  assert.deepEqual(validateControlEvent({ type: 'hotkey', keys: ['Control', 'c'] }), {
    capability: 'keyboard', event: { type: 'hotkey', keys: ['control', 'c'] },
  });
  assert.throws(() => validateControlEvent({ type: 'hotkey', keys: ['a', 'b'] }), /modifier/);
});

test('bounds clipboard text and rejects unsupported event types', () => {
  assert.deepEqual(validateControlEvent({ type: 'clipboard', text: 'safe' }), {
    capability: 'clipboard', event: { type: 'clipboard', text: 'safe' },
  });
  assert.throws(() => validateControlEvent({ type: 'clipboard', text: 'x'.repeat(4097) }), /too large/);
  assert.throws(() => validateControlEvent({ type: 'shell', command: 'whoami' }), /unsupported/);
});

test('bounds WebRTC descriptions and ICE candidates', () => {
  assert.deepEqual(validateSignalPayload({
    description: { type: 'offer', sdp: 'v=0\r\n' },
    candidate: { candidate: 'candidate:1 1 UDP 1 127.0.0.1 9 typ host', sdpMid: '0', sdpMLineIndex: 0 },
  }), {
    description: { type: 'offer', sdp: 'v=0\r\n' },
    candidate: {
      candidate: 'candidate:1 1 UDP 1 127.0.0.1 9 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
      usernameFragment: null,
    },
  });
  assert.throws(() => validateSignalPayload({ description: { type: 'rollback', sdp: 'x' } }), /invalid/);
  assert.throws(() => validateSignalPayload({ candidate: { candidate: 'x'.repeat(2049) } }), /too large/);
  assert.throws(() => validateSignalPayload({}), /empty/);
});

test('blocks repeated PIN failures and resets after success', () => {
  let clock = 1_000;
  const limiter = createAttemptLimiter({ maxFailures: 3, windowMs: 1000, blockMs: 5000, now: () => clock });
  assert.equal(limiter.check('ip:host').allowed, true);
  limiter.failure('ip:host');
  limiter.failure('ip:host');
  assert.equal(limiter.failure('ip:host').allowed, false);
  assert.ok(limiter.check('ip:host').retryAfterMs > 0);
  limiter.success('ip:host');
  assert.equal(limiter.check('ip:host').allowed, true);
  clock += 10_000;
  limiter.sweep();
});

test('rate limits high-frequency control event streams', () => {
  let clock = 0;
  const limiter = createRateLimiter({ maxEvents: 2, windowMs: 1000, now: () => clock });
  assert.equal(limiter.consume('viewer'), true);
  assert.equal(limiter.consume('viewer'), true);
  assert.equal(limiter.consume('viewer'), false);
  clock = 1000;
  assert.equal(limiter.consume('viewer'), true);
});

test('sanitizes viewer labels without retaining control characters', () => {
  assert.equal(sanitizeLabel('  Alice\n Support  '), 'Alice Support');
  assert.equal(sanitizeLabel('', 'Viewer'), 'Viewer');
  assert.equal(sanitizeLabel('x'.repeat(100)).length, 80);
});
