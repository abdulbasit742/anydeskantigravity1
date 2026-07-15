# DeskRTC

DeskRTC is a small Electron + Node.js attended remote-support prototype. It shares a host-selected screen through WebRTC and relays narrowly validated pointer, keyboard, or clipboard events only after the host approves an individual viewer.

## Current safety boundary

A valid session ID and PIN do **not** admit a viewer. The flow is:

1. The host selects a screen and starts a session.
2. The viewer verifies a short-lived PIN invitation.
3. The host sees a pending viewer label.
4. The host approves screen view and optionally grants pointer, keyboard, or clipboard access to that viewer.
5. The host can revoke the viewer, stop the local agent, stop screen sharing, or end the session at any time.

PINs are held only as salted scrypt hashes. PIN attempts are rate limited. Viewer invitations and the local-agent credential are opaque and session-scoped. Signalling and control messages are size-bounded and schema-validated.

## Local-only default

The server binds to `127.0.0.1` by default and has no public session-list endpoint. Browser origins default to the local server only. The WebRTC configuration has no hard-coded third-party STUN/TURN service, so the baseline is intended for same-machine or controlled local-network development.

Do not expose this prototype directly to the internet. A public deployment requires HTTPS/WSS, authenticated operator accounts, trusted reverse-proxy configuration, durable session/audit storage, short-lived TURN credentials, abuse controls, and an independent security review.

## Run the browser prototype

Requirements: Node.js 20 or newer.

```bash
npm install --ignore-scripts --no-audit --no-fund
npm run server
```

Open `http://127.0.0.1:3000`.

Optional local environment values are documented in `.env.example`.

## Run the Electron host

Install the Node dependencies, then install the Python packages used by the optional local control agent:

```bash
python -m pip install -r requirements.txt
npm start
```

The Electron renderer cannot choose an arbitrary agent server. The main process pins the agent to its own loopback server and passes a one-session agent credential through a narrow, isolated preload bridge.

## Verification

```bash
npm run check
python -m py_compile host-agent.py
```

The dependency-free suite currently contains 24 tests covering PIN hashing, invitation and origin policy, brute-force and control-event limits, signalling schemas, viewer approval, agent authorization, Electron isolation, and the browser trust boundary.

Dependency installation could not be completed in the local verification environment because its package-network request timed out. CI runs installation and the same verification commands on Node.js 20 and 22.

## Responsible use

DeskRTC is for authorized, attended support only. Hidden access, surveillance, credential collection, identity-verification evasion, deceptive media substitution, and unattended persistence without informed authorization are outside the project scope.

See [SECURITY.md](SECURITY.md) and [docs/security-audit.md](docs/security-audit.md) before extending the transport or control surface.
