# AGENTS.md

## Scope

These instructions apply to the entire `abdulbasit742/anydeskantigravity1` repository.

Project: **DeskRTC**, an Electron + Node.js attended remote-support prototype.

## Trust boundaries

- `server.js`: session admission, signalling relay, per-viewer authorization, and rate limits.
- `lib/security.js`: pure validation, hashing, token, origin, and limiter primitives.
- `electron-main.js`: trusted local process and Python-agent lifecycle.
- `preload.js`: narrow renderer-to-main bridge.
- `host-agent.py`: final host input boundary; validate again before PyAutoGUI/clipboard use.
- `public/host.js` and `public/viewer.js`: untrusted browser-facing state and WebRTC negotiation.

## Commands

```bash
npm install --ignore-scripts --no-audit --no-fund
npm run check
python -m py_compile host-agent.py
npm run server
npm start
```

## Working rules

1. Preserve attended access: PIN verification is never equivalent to host consent.
2. Keep viewer permissions per viewer and minimum-scope; do not restore a global control switch.
3. Keep the server loopback-only and CORS explicit by default.
4. Never reintroduce session enumeration, plaintext PIN storage, raw control relay, arbitrary renderer-selected agent URLs, background clipboard polling, or hard-coded third-party relay services.
5. Treat SDP, ICE candidates, Socket.IO packets, IPC arguments, labels, keys, and clipboard text as untrusted input.
6. Do not enable unattended access, hidden control, camera substitution, identity-verification bypass, persistence, shell execution, or file transfer without a separate threat model and explicit authorization design.
7. Update tests, scanner rules, README, and security audit whenever a trust boundary changes.

## Completion checklist

- `npm run check` passes.
- Python source compiles.
- No secrets, session data, recordings, binaries, or populated environment files are introduced.
- Host approval, revocation, expiry, error, and denied-permission behavior remain visible and fail closed.
