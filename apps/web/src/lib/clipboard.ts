// SPDX-License-Identifier: AGPL-3.0-or-later
// Copy text that may still be on its way (e.g. a token being created when the button is pressed).
// Safari only allows clipboard writes inside the click, so a pending text goes through
// ClipboardItem with a promise, which keeps the user activation. Other paths are fallbacks.

export class CopyError extends Error {
  constructor() {
    super("Clipboard unavailable");
    this.name = "CopyError";
  }
}

function legacyCopy(text: string): boolean {
  // Plain http:// on a LAN has no async clipboard API. The text sits in the DOM for one tick.
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.className = "copy-buffer";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

/**
 * Copy `text` (or the text a promise resolves to). If producing the text fails, that error is
 * rethrown untouched, so callers can show an API error; a clipboard failure throws CopyError.
 */
export async function copyText(text: string | Promise<string>): Promise<void> {
  const pending = Promise.resolve(text);
  const clip: Clipboard | undefined =
    typeof navigator !== "undefined" ? navigator.clipboard : undefined;

  if (
    typeof text !== "string" &&
    clip &&
    typeof clip.write === "function" &&
    typeof ClipboardItem !== "undefined"
  ) {
    try {
      const blob = pending.then((value) => new Blob([value], { type: "text/plain" }));
      // Avoid an unhandled rejection if the write itself fails before consuming the blob.
      blob.catch(() => undefined);
      await clip.write([new ClipboardItem({ "text/plain": blob })]);
      return;
    } catch {
      // Fall through: either the text failed (rethrown below) or this browser rejects promised items.
    }
  }

  const value = await pending;
  if (clip && typeof clip.writeText === "function") {
    try {
      await clip.writeText(value);
      return;
    } catch {
      // Fall through to the legacy path.
    }
  }
  if (!legacyCopy(value)) throw new CopyError();
}
