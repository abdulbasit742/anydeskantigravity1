'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const findings = [];
const skippedDirectories = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'release', '__pycache__']);

function report(file, rule, detail) {
  findings.push({ file, rule, detail });
}

function walk(relative = '') {
  const absolute = path.join(root, relative);
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) walk(next);
    } else {
      inspect(next.split(path.sep).join('/'));
    }
  }
}

function inspect(file) {
  const absolute = path.join(root, file);
  const stat = fs.statSync(absolute);
  if (stat.size > 1_500_000) report(file, 'large-file', 'unexpected file exceeds 1.5 MB');
  if (/\.(?:pem|key|p12|pfx)$/i.test(file)) report(file, 'private-key-file', 'private key-like file is not allowed');
  if (/(^|\/)\.env(?:\.|$)/.test(file) && file !== '.env.example') report(file, 'populated-env', 'only .env.example may be tracked');
  if (!/\.(?:js|mjs|cjs|py|html|css|json|md|txt|yml|yaml)$/i.test(file)) return;
  const text = fs.readFileSync(absolute, 'utf8');
  const credentialPatterns = [
    ['openai-token', /\bsk-[A-Za-z0-9_-]{20,}\b/g],
    ['github-token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g],
    ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/g],
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ];
  for (const [rule, pattern] of credentialPatterns) {
    if (pattern.test(text)) report(file, rule, 'credential-shaped value found');
  }
}

walk();

const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const server = read('server.js');
const electron = read('electron-main.js');
const preload = read('preload.js');
const agent = read('host-agent.py');
const hostHtml = read('public/host.html');
const viewerHtml = read('public/viewer.html');
const hostJs = read('public/host.js');
const viewerJs = read('public/viewer.js');

if (/origin\s*:\s*['"]\*['"]|CORS_ORIGIN\s*\|\|\s*['"]\*['"]/.test(server)) report('server.js', 'wildcard-cors', 'browser origins must be explicit');
if (server.includes("app.get('/api/sessions'")) report('server.js', 'session-enumeration', 'active session IDs must not be publicly enumerable');
if (!/pinHash:\s*hashPin\(pin\)/.test(server)) report('server.js', 'plaintext-pin', 'session PIN must be stored as a salted hash');
if (!/createAttemptLimiter/.test(server) || !/status\(429\)/.test(server)) report('server.js', 'pin-rate-limit', 'PIN verification must be rate limited');
if (!/approve-viewer/.test(server) || !/pendingViewers/.test(server)) report('server.js', 'viewer-consent', 'viewer admission must require host approval');
if (!/verifyToken\(payload\.agentToken/.test(server)) report('server.js', 'agent-auth', 'agent registration must require a session credential');
if (!/validateControlEvent\(rawEvent\)/.test(server)) report('server.js', 'control-schema', 'control events must be validated before relay');
if (!/BIND_HOST\s*=\s*process\.env\.BIND_HOST\s*\|\|\s*['"]127\.0\.0\.1['"]/.test(server)) report('server.js', 'unsafe-bind-default', 'default bind address must remain loopback');
if (/nodeIntegration:\s*true|contextIsolation:\s*false|sandbox:\s*false/.test(electron)) report('electron-main.js', 'electron-isolation', 'unsafe renderer privileges found');
if (!/isTrustedSender/.test(electron) || !/will-navigate/.test(electron)) report('electron-main.js', 'electron-navigation', 'IPC sender and navigation must be restricted');
if (preload.includes('serverUrl')) report('preload.js', 'renderer-server-selection', 'renderer must not select an arbitrary agent server URL');
if (!agent.includes('--agent-token') || !agent.includes("'agentToken': agent_token")) report('host-agent.py', 'agent-token', 'agent credential is not enforced');
if (!agent.includes('HTTP on a loopback address')) report('host-agent.py', 'agent-url-policy', 'agent must reject remote plaintext HTTP servers');
if (agent.includes('clipboard_loop')) report('host-agent.py', 'background-clipboard-read', 'agent must not poll the host clipboard');
for (const [file, html] of [['public/host.html', hostHtml], ['public/viewer.html', viewerHtml]]) {
  if (/<script(?![^>]*\ssrc=)[^>]*>/i.test(html)) report(file, 'inline-script', 'inline scripts weaken CSP and reviewability');
}
if (/stun:|turn:|https?:\/\//i.test(hostJs + viewerJs)) report('public/*.js', 'undeclared-third-party-network', 'public session scripts contain a hard-coded external network endpoint');
if (/eval\s*\(|new\s+Function\s*\(/.test(server + electron + preload + hostJs + viewerJs)) report('active JavaScript', 'dynamic-code', 'dynamic code execution found');
if (/navigator\.clipboard\.writeText\([^)]*(?:token|agent|command)/i.test(hostJs)) report('public/host.js', 'credential-copy', 'agent credentials must not be copied to the browser clipboard');

if (findings.length) {
  console.error(`Security check failed with ${findings.length} finding(s):`);
  for (const finding of findings) console.error(`- ${finding.file} [${finding.rule}]: ${finding.detail}`);
  process.exit(1);
}

console.log('Security check passed for the active DeskRTC source tree.');
