# Share a presentation

You hand over your presentation, PPTaken hosts it, people just open a link. Nobody needs an account. This guide shows
the two kinds of link, what each person sees, and how to stop sharing. The decisions behind it are in
[ADR-026](../adr/0026-public-links.md).

## 1. Make a link

Open the presentation in the panel (**Presentations**, click its title) and press **Share** next to Present. Choose
who the link is for:

- **Anyone with the link can watch.** They see the slides and move through them with the arrow keys or by clicking.
  They do not see your notes, and interactive parts stay off (they see the simple version). They cannot download or
  print it from PPTaken, and they never see your panel or your other presentations.
- **For the person who will present (includes your notes).** They present from their own computer: the slides on
  the big screen and, with **S**, a presenter window with your notes, the clock and the next slide. **Anyone who has
  this link can read your notes**, so send it only to that person.

Then, if you like:

- **The link works**: until you stop it, for 1, 7 or 30 days, or until a day you pick (within a year).
- **Name (only you see it)**: who it is for, like "Q3 review for Ana". It helps you know which link went where.
- **Freeze this version**: later changes Claude makes do not reach this link. Leave it off and the link always shows
  the latest version.

Press **Create link**. Copy it, or show a **QR code** to open it on a phone. You can come back to Share at any time
to copy a link again.

## 2. What the other person sees

- A clean page where the slide fills the screen. A quiet line says which keys to use; **?** shows them all; **F** is
  full screen; **O** is the overview of slides.
- With a presenter link, **S** opens the presenter window. If the presentation has interactive parts you allowed,
  the presenter presses **U** and types your **presenter password** to turn them on (see
  [Interactive presentations](interactive-decks.md#5-the-presenter-password)). Send the password separately from
  the link. If you have not set one, the Share panel says so and links to **Security**.
- If the network drops during the talk, the slides keep working (they are already loaded). Reloading the page needs
  a connection: a link never leaves a copy of your presentation on someone else's computer.
- A link that no longer works shows a calm page: "This link is not available anymore. Ask the person who shared it
  for a new one." It does not say why.

## 3. Keep track and stop sharing

Share lists every link with its name, what it opens, when it stops working and when it was last opened. Next to each:

- **Copy link**.
- **Stop sharing**: it stops working right away. Nobody can open it again, and a page someone already has open
  cannot reload it or turn on its interactive parts (what is already on their screen stays until they close it).
  There is no way to turn the same link back on; make a new one instead.
- **Turn it on for 7 more days**, for a link that reached its end date.
- **Stop sharing all links**, when there is more than one.

The list of presentations shows a quiet **Shared** mark on presentations with links that work.

## 4. The trash

- Moving a presentation to the trash **turns its links off** right away. The confirmation says how many.
- **Undo** right after moving it brings everything back, links included.
- Restoring it later from **Trash** asks first: *Turn those links back on*, unchecked unless you tick it. Links you
  stopped yourself never come back.
- Deleting it forever deletes its links too.

## 5. Turning sharing off

- **Settings › Sharing › Allow links that open without an account**: off makes every shared link stop working until
  you turn it on again. Your links are kept.
- Whoever runs your PPTaken can turn links off for everyone with `PPTAKEN_PUBLIC_LINKS=off`. The Share panel then
  explains it.

## 6. Good to know

- A link is like a key: anyone who has it can open the presentation. Use an end date and a name, and stop links you no
  longer need.
- Links are hidden from search engines and are never sent to other sites (no "referrer").
- Claude and other connected apps **cannot** create, see or stop links. If you ask Claude to share a presentation, it
  points you to Share in the panel.
- If whoever runs your PPTaken changes its secret key, every link stops working and Share asks you to make new ones.

## For whoever runs PPTaken

- `PPTAKEN_PUBLIC_LINKS=on|off` (default `on`).
- Link pages are `/s/<secret>` on the public address; the content of the slides comes from the content origin, as for
  the owner (`PPTAKEN_CONTENT_URL`).
- Logs show `/s/<link>` instead of the secret. The audit log names links by id.
- Limits: 50 active links per presentation, 500 per instance; 300 link pages per minute per IP; repeated wrong links
  from one network (20 in 10 minutes), or 300 instance-wide, pause link pages with a "try again in a few minutes"
  page.
