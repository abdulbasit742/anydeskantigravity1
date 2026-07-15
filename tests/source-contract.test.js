'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('server does not expose a session enumeration endpoint', () => {
  assert.equal(read('server.js').includes("app.get('/api/sessions'"), false);
});

test('server hashes PINs instead of retaining plaintext session PINs', () => {
  const source = read('server.js');
  assert.match(source, /pinHash:\s*hashPin\(pin\)/);
  assert.equal(/\bpin:\s*String\(pin\)/.test(source), false);
});

test('viewer admission requires an explicit host approval event', () => {
  const source = read('server.js');
  assert.match(source, /socket\.on\('approve-viewer'/);
  assert.match(source, /pendingViewers/);
  assert.match(source, /viewer-approved/);
  assert.match(source, /validateSignalPayload\(data\)/);
});

test('local agent registration requires a session credential', () => {
  assert.match(read('server.js'), /verifyToken\(payload\.agentToken/);
  assert.match(read('host-agent.py'), /--agent-token/);
  assert.match(read('host-agent.py'), /'agentToken': agent_token/);
});

test('Electron renderer cannot choose an arbitrary agent server URL', () => {
  const main = read('electron-main.js');
  const preload = read('preload.js');
  assert.equal(preload.includes('serverUrl'), false);
  assert.match(main, /'--server', baseUrl/);
  assert.match(main, /isTrustedSender/);
});

test('Electron window keeps isolation, sandboxing, and navigation restrictions', () => {
  const source = read('electron-main.js');
  assert.match(source, /contextIsolation:\s*true/);
  assert.match(source, /nodeIntegration:\s*false/);
  assert.match(source, /sandbox:\s*true/);
  assert.match(source, /will-navigate/);
});

test('public pages use external local scripts and no hard-coded third-party STUN server', () => {
  for (const file of ['public/host.html', 'public/viewer.html']) {
    const html = read(file);
    assert.equal(/<script(?![^>]*\ssrc=)[^>]*>/i.test(html), false);
  }
  assert.equal(read('public/host.js').includes('stun.l.google.com'), false);
  assert.equal(read('public/viewer.js').includes('stun.l.google.com'), false);
});

test('viewer UI makes host approval and capability scope visible', () => {
  const html = read('public/viewer.html');
  const script = read('public/viewer.js');
  assert.match(html, /host approval required/i);
  assert.match(script, /awaiting-host-approval/);
  assert.match(script, /Host-approved capabilities/);
});
