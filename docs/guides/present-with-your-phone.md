# Present with your phone

Your phone can drive a presentation: next and previous, a black screen, a laser pointer, and, for you only, the
speaker notes, the next slide and a clock. Nothing to install: the phone opens a page of your PPTaken server.

## Pair a phone

1. Open the presentation (**Present**) on the laptop connected to the projector.
2. Press **R**. A panel with a QR code opens on the laptop. (In the presenter window, press the **Remote control**
   button instead: the QR then stays off the projector.)
3. Scan the QR code with the phone's camera and open the link. The phone shows a two-digit code.
4. The laptop asks "Allow Android · Chrome · 42?". Check that the digits match, then press **Enter** (or click
   **Allow**). **Escape** denies. Close the panel with **Escape** or **R**.

The QR code works once and for two minutes; the panel makes a new one when it expires. Up to two phones can be
paired with a presentation. The phone stays paired for the session (at most 12 hours), even if you reload either page.

## On the phone

- **Previous / Next** step through the slides and their steps; **First**, **Last** and **Black screen** too.
- **Laser**: drag your finger over the slide preview; a red dot follows on the projector and disappears 1.5 seconds
  after you stop (and never shows over a black screen).
- **Notes**, the **next slide** and a **clock** (start, pause, reset; pace when the presentation has a timing plan)
  appear once the laptop approved the phone. The phone's clock is its own; it is not synced with the presenter window.
- The phone only shows positions the projector confirmed. If it says **Screen offline**, the presentation page on the
  laptop is closed or disconnected; taps are not queued.

## Take control back

Press **K** on the laptop to disconnect every paired phone at once (they must scan a new code to come back). The
panel also lists each phone with **Remove**.

## Networks

- If the laptop page is on `localhost`, the phone cannot reach it: the panel offers your computer's network
  addresses (for example `http://192.168.1.20:8080`). Set `PPTAKEN_PUBLIC_URL` to skip that choice.
- On plain `http://`, everything works, but commands, the pairing code and your notes travel unencrypted on the
  network, and the phone cannot keep its screen awake by itself: set the phone not to lock during the talk. Use
  HTTPS (see the deployment guide) on networks you do not trust.
- If the server stops during the talk, the laptop keeps presenting. The phone reconnects by itself when the server
  is back.
