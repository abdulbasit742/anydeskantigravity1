# Security and Responsible Use

DeskRTC is intended only for remote support and remote access sessions where the host user has clearly consented.

## Safe-use rules

- Do not connect to, view, or control a device without permission from the device owner/user.
- Use a strong session PIN.
- Keep the host screen-sharing indicator visible during sessions.
- Stop the Python control agent when remote control is no longer needed.
- Do not expose the signaling server publicly without HTTPS and stricter authentication.

## Deployment recommendations

- Use HTTPS/WSS in production.
- Restrict CORS origins instead of using wildcard origins.
- Store sessions in a proper backend if scaling beyond local testing.
- Add audit logs for remote-control events.
- Never commit `.env`, private keys, tokens, packaged `.exe` files, or dependency folders.
