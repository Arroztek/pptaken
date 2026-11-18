# Interactive presentations

Your agent can add JavaScript to slides: live charts, small simulations, sliders that change a diagram. PPTaken
treats that code as untrusted until **you** read it and approve it, and it runs only where it is safe to. This guide
explains how to turn it on, review it and present it. The decisions behind it are in
[ADR-020](../adr/0020-interactive-mode.md) and [ADR-021](../adr/0021-presenter-password-and-approval-screen.md).

## 1. Turn it on

Interactive code is off by default. Whoever runs your PPTaken sets one environment variable and restarts it:

```sh
PPTAKEN_SCRIPTS=owner
```

With it off, slides with code still work: everyone sees their static version, and the presentation page in the
panel shows the code and explains how to turn it on.

## 2. What your agent does

Your agent writes each slide's code in its `script` field and lists libraries (for example the bundled uPlot) in
`libs`. It cannot approve anything. After every change to the code, its tool result says
`pending_owner_approval` with an `approve_url`; a good agent tells you to open that link and read the code. It
should never tell you the code already runs.

## 3. Review and approve

Open the presentation in the panel (**Presentations**, click its title; or the agent's link). The **Interactive
scripts** section shows:

- whether scripts are on for this PPTaken;
- the approval state: waiting for your review, approved, or *changed since you approved it* (the agent edited the
  code after your approval: the presentation is static again until you approve the new code);
- the **fingerprint** (SHA-256 over every script and library): your approval binds to this exact value;
- every script, with line numbers, its size and its own fingerprint (long scripts show the first 200 lines and a
  "Show all" button);
- the libraries, with version, fingerprint and the address they were copied from (viewers never contact it);
- what the static version leaves out (for example a `<canvas>`), so you can check the slides still make sense
  without the code.

Read the code. **This code will run in your browser when you present this deck. It cannot reach the network.
Approve only code you or your agent wrote and you have read.** Then press **Approve these scripts**, check the
fingerprint in the dialog, tick the confirmation and approve. If the agent changed the code while you were reading,
nothing is approved: the page tells you and shows the new code.

**Stop running scripts** withdraws the approval at once.

## 4. Where the code runs

- When **you** present from your own signed-in panel session: yes, once approved.
- On a screen **without** your session (presenter links, when they arrive in a later version): only after someone
  types the **presenter password** there (below).
- Phones used as remotes, the presenter view's previews, exports (`.html`, `.pkn`) and offline copies: never. They
  always show the static version.
- `?safe=1` on the player URL forces the static version.

## 5. The presenter password

**Security › Presenter password** sets one password for this PPTaken that unlocks approved code on screens where you
are not signed in.

- It is **not** your owner password and it cannot open the panel. PPTaken refuses to make them equal.
- At least 12 characters. Use one you do not use anywhere else: you may type it on other people's computers.
- On that screen, press **U** (not Ctrl+anything). PPTaken shows its own dialog over the whole page with the
  server's address; type the password. PPTaken never asks for it in any other way, and never inside a slide.
- An unlock lasts at most 8 hours, in that browser tab only. It ends early when the code changes, when you withdraw
  the approval, or when you change or remove the presenter password.
- Too many wrong attempts lock the unlock for a while (per computer, per presentation, and for everyone during an
  attack).
- If you typed it on a computer you do not trust, change it afterwards: every unlock made with the old one ends.
- Forgot it? Set a new one in Security. `pptaken reset-password --clear-presenter-password` removes it together with
  an owner password reset.

## 6. Offline

Offline, presentations always show their static version and never ask for a password. If you need the interactive
version, unlock while you are online and keep the connection. The presenter view reminds you: *Interactive mode
needs a connection. Unlock before you go offline.*

## A separate site for content

A runaway script (an endless loop) **can freeze the presenter tab in Firefox and Safari**. Chrome keeps it contained
and PPTaken replaces it with the static version after a few seconds. For stronger isolation, serve slide content
from a **different site** than the panel:

```sh
PPTAKEN_PUBLIC_URL=https://slides.example.com
PPTAKEN_CONTENT_URL=https://content.example.net
```

Both names must point to the same PPTaken. A subdomain of the same site (`content.example.com` next to
`slides.example.com`) does **not** count: browsers isolate by site, not by subdomain. On a self-hosted instance this
is optional; the presentation page shows an amber warning while it is missing.
