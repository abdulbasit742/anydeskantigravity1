# Remote-support reference review

Reviewed on 2026-07-15.

## RustDesk

Adopted: an explicit unauthorized-use boundary, self-hosting as a data-control decision, and separation between rendezvous/relay and client-side media/input services.

Not adopted: Rust/Flutter implementation, public relay infrastructure, codecs, file transfer, unattended access, or platform input services.

## MeshCentral

Adopted: server/agent handshake as an authenticated trust boundary, administrator-oriented TLS/MFA posture, and a clear distinction between browser-to-server signalling and device-agent capability.

Not adopted: device inventory, persistent agents, terminal/file management, multi-tenancy, or its large server architecture.

## Remotely

Adopted: attended-access enforcement, authentication as a remote-control requirement, trusted CORS/proxy configuration, visible user notification, and retention-aware logging as production requirements.

Not adopted: account/database stack, organizations, scripting, recording, installers, or internet deployment defaults.

## Resulting change

The smallest coherent improvement was a host-approved admission and authorization layer around the existing WebRTC prototype: hashed PIN verification, bounded attempts, one-time viewer invitations, per-viewer scopes, authenticated local agent registration, bounded signalling/control payloads, and local-only defaults.
