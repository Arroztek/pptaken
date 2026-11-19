# Interactive presentations

Your agent can add JavaScript to slides: live charts, small simulations, sliders that change a diagram. PPTaken
treats that code as untrusted until **you** read it and approve it, and it runs only where it is safe to. This guide
explains how to turn it on, review it and present it. The decisions behind it are in
[ADR-020](../adr/0020-interactive-mode.md), [ADR-021](../adr/0021-presenter-password-and-approval-screen.md) and
[ADR-022](../adr/0022-vendoring-and-html-importer.md).

## 1. Turn it on

Interactive code is off by default. Whoever runs your PPTaken sets one environment variable and restarts it:

```sh
PPTAKEN_SCRIPTS=owner
```

With it off, slides with code still work: everyone sees their static version, and the presentation page in the
panel shows the code and explains how to turn it on.

## 2. What your agent does

Your agent writes each slide's code in its `script` field, shared helpers in the deck-level `script`, and lists
libraries in `libs`: a CDN URL of the library's classic build (for example
`https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js`) or the bundled uPlot. PPTaken downloads each library
**once**, when the deck is written, stores it and pins its SHA-256 (ADR-022): you approve exactly those bytes, and
nobody who views the deck ever contacts the CDN. It can also bring a whole HTML artifact with `import_html_deck`
(see [Bring your Claude artifact](bring-your-artifact.md)). It cannot approve anything. After every change to the
code or to a library, its tool result says `pending_owner_approval` with an `approve_url` and a short `message_for_user` that the agent
relays to you word for word. It should never tell you the code already runs.

## 3. Allow them (one click)

Open the presentation in the panel (**Presentations**, click its title), or the link your agent gives you
(`/decks/<id>/approve`: one screen with a single **Allow** button; if you are signed out you sign in and come back
to it). The page says in one line what is being allowed: interactive parts Claude added, or a **new piece from an
outside site** (a library). It runs only in your browser while you present; it cannot reach the internet or your
files.

- **See what will run** (a quiet link) shows every piece of code with line numbers (long code shows the first 200
  lines and "Show all"), the deck-level code and the libraries with the address they came from.
- If the code has a mistake PPTaken can see without running it, the page says so and asks for one extra
  **Allow anyway**.
- If Claude changed the code while the page was open, nothing is allowed: the page says so and shows the new code.

### Later edits: allowed automatically (ADR-024)

With **Settings › Allow interactive updates automatically** on (the default), later edits Claude makes to the same
presentation's code keep running **without asking**. The deck page says "Updated by Claude {time}; allowed
automatically" and offers **Review changes** (before and now, side by side). It always asks again for:

- a **new library** (a new address or new contents), even with the setting on;
- any change, when you turned the setting off;
- any change after **Turn interactive parts off for this presentation** (that ends the trust until you allow again).

Automatically allowed code runs only in your own signed-in browser, never on presenter-password screens.

### Developer details

**Settings › Developer details** shows the technical side: the fingerprint (SHA-256 over every script and library)
that an approval binds to, whether the approval was yours or automatic, the instance switch, the content origin, the
static check, what the simple version leaves out, the provenance of saved files (URLs, redirects, hashes) and the raw
script errors.

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

## When a script fails

If something goes wrong in the code while you present, the slides keep working (the broken parts show their static
version) and nothing appears on the screen your audience sees. Instead:

- **The presenter view** shows a notice: what happened, what to do, a link to the presentation's page and **Copy a
  message for my agent** (a ready-to-paste sentence with the presentation's title and id). If the code froze the page,
  it says the presentation switched to the static version. If the code is not approved yet, it tells you to open the
  presentation's page and approve it.
- **The presentation's page** (Interactive section) has a **Script errors** block: for each error, the slide, where it
  happened, the error text, how many times and when, and what it usually means. *"root is not defined"* means the
  script must start with `var root = slide.root;`; *"Cannot read properties of null"* means a selector did not find
  an element in the slide; anything about `fetch` means the script tried to use the network, which presentations
  never allow. **Copy for my agent** copies a short summary to paste into your Claude chat; **Clear** empties the
  list. The list of presentations marks a deck with errors in amber.
- **Your agent** sees the same list with `get_presentation` (`script_errors`), clearly marked as untrusted text, and
  every write already warns about the most common mistakes before you approve (a syntax error asks you to confirm
  twice).

Ask your agent to fix the scripts, approve the new code and present again. Errors are recorded only for code you
approved, only while you present it from your own session, and only the latest 30 per version are kept; errors of the
previous version stay visible, labelled as such, until the code changes again.

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
