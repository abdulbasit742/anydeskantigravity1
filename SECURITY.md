# Security and Responsible Use

DeskRTC is intended only for attended remote-support sessions where the person at the host device knowingly approves the viewer and the requested capabilities.

## Enforced baseline

- local loopback bind and explicit browser-origin allowlist by default;
- no public active-session enumeration;
- six-or-more-digit PINs stored as salted scrypt hashes;
- bounded PIN failures with temporary blocking;
- short-lived, one-time viewer invitation tokens;
- explicit host approval for every viewer;
- separate per-viewer pointer, keyboard, and clipboard permissions;
- session-scoped authenticated local agent;
- bounded signalling, control, clipboard, and Socket.IO payloads;
- Electron context isolation, sandboxing, no renderer Node integration, and restricted navigation/IPC;
- host-visible screen-sharing indicator, viewer queue, revocation, agent stop, and session end controls.

## Public deployment requirements

Do not expose the current server directly. Before internet use, add authenticated users and tenants, HTTPS/WSS, CSRF-aware APIs, trusted proxies, persistent rate limiting, durable append-only audit, short-lived TURN credentials, relay abuse controls, session revocation across processes, and operational monitoring.

## Reporting

Do not include real credentials, session PINs, agent tokens, personal screen content, or sensitive host logs in a public issue. Provide a minimal synthetic reproduction.
