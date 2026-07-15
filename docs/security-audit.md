# Changed-area security audit — 2026-07-15

## Fixed

- Removed the unauthenticated `/api/sessions` enumeration endpoint.
- Replaced plaintext in-memory PINs with salted scrypt hashes.
- Added per-IP/session failed-PIN blocking and short-lived invitation tokens.
- Changed viewer admission from automatic-after-PIN to explicit host approval.
- Replaced the global remote-control toggle with per-viewer pointer, keyboard, and clipboard scopes.
- Added a session-scoped credential for the Python agent.
- Validated and bounded SDP, ICE candidates, input events, clipboard text, labels, JSON bodies, and Socket.IO packets.
- Added control-event rate limiting.
- Removed background clipboard polling from the host agent.
- Prevented the renderer from selecting an arbitrary agent server.
- Added Electron sandboxing, trusted-sender checks, and navigation restrictions.
- Removed inline page scripts and the hard-coded third-party STUN endpoint.
- Added security headers, source regression checks, tests, and CI.

## Residual risks

- Sessions, limits, and audit events are in process memory; multi-instance deployment would bypass or fragment them.
- There are no user accounts, tenant authorization, durable audit records, CSRF tokens, or reverse-proxy trust configuration.
- Origin-less native Socket.IO clients are allowed because the authenticated Python agent does not send a browser Origin header. Agent credentials and viewer PIN/invitation flows remain mandatory.
- Host IDs are not secrets. Security depends on PIN entropy, rate limits, invitation expiry, and host approval.
- The optional agent can control pointer/keyboard and write clipboard data after approval; a compromised host or dependency can abuse those privileges.
- No public STUN/TURN service is configured. Internet connectivity and relay credentials are deliberately out of scope.
- Dependencies could not be installed/audited in the local environment because the package-network request timed out. CI installation is the remote verification gate.
- There is no packaged-app signing, auto-update verification, or sandbox review across all supported operating systems.
