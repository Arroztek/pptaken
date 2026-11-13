# ADR-007 · Bluetooth: not between browsers; yes for physical clickers

**Founder's question:** can the phone control the laptop over Bluetooth?

**Research (2026-11).**
- **Web Bluetooth** only exists in Chromium browsers (Chrome, Edge, Opera, on desktop and Android). **Safari (macOS and iOS) and Firefox do not implement it**, and Apple has announced no plans. On iOS all browsers use Safari's engine: every iPhone is left out.
- More important: Web Bluetooth only lets the browser act as a **client** (central) of a peripheral. **A browser cannot advertise itself as a peripheral**, so two browsers cannot talk to each other over Bluetooth, not even Chrome with Chrome.
- **Local WebRTC** works between devices on the same network, but it requires a signaling server for the initial handshake. If that server is reachable, WebSocket already solves the problem.

**Decision.** Browser↔browser Bluetooth is not implemented. It is not our limitation but the web platform's.

**What we do instead:**
1. **Physical Bluetooth/USB clickers**: they present themselves to the system as a keyboard. The player maps the keys they emit (PageDown/PageUp, arrows, `b` or `.` for black screen, F5/Esc). It works without a network and without a server. It is the official recommendation for rooms without WiFi.
2. **No internet but local network**: server on the same WiFi, or on the laptop itself with the phone connected to the laptop's *hotspot*. Documented as the "airplane mode" recipe.
3. **v1.1**: lock-screen and Bluetooth headset controls via MediaSession (the near-silent audio technique from `ppt`), Android/Chromium only.
