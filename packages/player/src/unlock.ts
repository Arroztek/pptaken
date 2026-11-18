// SPDX-License-Identifier: Apache-2.0
// Presenter-password unlock, trusted side (ADR-021). Runs in the player PAGE (outside the content iframe) when the
// page is served without an owner session (future presenter/public links; today the test-only guest page).
//
// - Opened by one plain key, `U` (no modifier: browsers reserve Ctrl/Cmd combinations), pressed on the trusted page.
//   The content frame cannot open it: its key events never reach this document (cross-origin frame), its
//   forwarded keys travel over the player protocol whose closed key set has no `U`, and this module never listens
//   to messages. Synthetic events (`isTrusted === false`) are ignored.
// - The dialog is plain DOM of the trusted page, above a full-viewport backdrop; while it is open the content frame
//   is `inert`. Focus is trapped inside; Esc closes it. The password is cleared after every attempt and never stored.
// - The token lives in `sessionStorage` only (this tab, wrapped in try/catch), never in a cookie or a URL.
// - Offline (or running from the offline copy) the dialog is not offered at all: the offline version is static and
//   never asks for a password; the presenter view explains it instead.

import { type Labels, type Locale, labelsFor } from "./i18n.js";

export const UNLOCK_STORAGE_PREFIX = "pptaken.unlock:";
/** Shape of a signed unlock token (`<payload>.<HMAC>`); anything else is never stored or sent. */
export const UNLOCK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,560}\.[A-Za-z0-9_-]{43}$/;
const DECK_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_PASSWORD = 1024;
const MONO = "'JetBrains Mono',ui-monospace,monospace";
const SANS = "Inter,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif";

export type UnlockOutcome =
  | { ok: true; token: string }
  | { ok: false; reason: "failed" | "locked" | "network"; retryAfterSec?: number };

/** The subset of `KeyboardEvent` the key check reads. */
export interface UnlockKeyLike {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
  isTrusted?: boolean;
  repeat?: boolean;
}

/** `U` with no modifier (Caps Lock allowed), a real key press, not a repeat. */
export function isUnlockKey(event: UnlockKeyLike): boolean {
  if (event.isTrusted === false || event.repeat === true || event.isComposing === true)
    return false;
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return false;
  return event.key === "u" || event.key === "U";
}

function sessionStore(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** The stored unlock token of a deck in this tab, or `null`. */
export function readUnlockToken(deck: string): string | null {
  if (!DECK_ID.test(deck)) return null;
  try {
    const value = sessionStore()?.getItem(UNLOCK_STORAGE_PREFIX + deck) ?? null;
    return value !== null && UNLOCK_TOKEN_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function storeUnlockToken(deck: string, token: string): void {
  if (!DECK_ID.test(deck) || !UNLOCK_TOKEN_PATTERN.test(token)) return;
  try {
    sessionStore()?.setItem(UNLOCK_STORAGE_PREFIX + deck, token);
  } catch {
    // Private mode or storage disabled: the unlock lasts until this page is reloaded.
  }
}

export function forgetUnlockToken(deck: string): void {
  try {
    sessionStore()?.removeItem(UNLOCK_STORAGE_PREFIX + deck);
  } catch {
    // Nothing stored.
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** POST /api/v1/presenter/unlock. No cookies are needed or sent; the answer is validated before use. */
export async function requestUnlock(
  deck: string,
  password: string,
  fetchImpl: FetchLike = (i, init) => fetch(i, init),
): Promise<UnlockOutcome> {
  let res: Response;
  try {
    res = await fetchImpl("/api/v1/presenter/unlock", {
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      headers: { "Content-Type": "application/json", "X-PPTaken-CSRF": "1" },
      body: JSON.stringify({ deckId: deck, password }),
    });
  } catch {
    return { ok: false, reason: "network" };
  }
  if (res.status === 429) {
    const after = Number.parseInt(res.headers.get("Retry-After") ?? "", 10);
    return {
      ok: false,
      reason: "locked",
      ...(Number.isFinite(after) && after > 0 ? { retryAfterSec: Math.min(after, 86_400) } : {}),
    };
  }
  if (!res.ok) return { ok: false, reason: res.status >= 500 ? "network" : "failed" };
  const body = (await res.json().catch(() => null)) as { token?: unknown } | null;
  const token = body?.token;
  if (typeof token !== "string" || !UNLOCK_TOKEN_PATTERN.test(token)) {
    return { ok: false, reason: "failed" };
  }
  return { ok: true, token };
}

export interface UnlockDialogOptions {
  doc: Document;
  /** Where the trusted layers go (the player page body). */
  mount: HTMLElement;
  locale?: Locale;
  /** The content frames to make inert while the dialog is open. */
  frames(): readonly HTMLIFrameElement[];
  /** Whether the unlock may be offered now: online and not running from the offline copy. */
  available(): boolean;
  submit(password: string): Promise<UnlockOutcome>;
  /**
   * After a successful unlock (the token is already stored): load the scripted version. Resolve `false` when the
   * server still served the static version (the dialog then says so).
   */
  onUnlocked(token: string): Promise<boolean>;
  /** Where focus goes when the dialog closes (default: the element focused before it opened). */
  returnFocus?(): HTMLElement | null;
}

export interface UnlockDialog {
  /** Opens the dialog when available; returns whether it opened. */
  open(): boolean;
  close(): void;
  readonly isOpen: boolean;
  /** Shows or hides the "Interactive mode" indicator (trusted layer, top-left). */
  setIndicator(on: boolean): void;
  /** Hides the indicator temporarily (black screen) without forgetting it. */
  setIndicatorVisible(visible: boolean): void;
  /** A short notice at the bottom of the page for a few seconds (e.g. the unlock ended). */
  flash(text: string): void;
  destroy(): void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  return el.isContentEditable || el.closest("input, textarea, select, [contenteditable]") !== null;
}

function format(text: string, n: number): string {
  return text.replace("{n}", String(n));
}

export function createUnlockDialog(options: UnlockDialogOptions): UnlockDialog {
  const { doc, mount } = options;
  const win = doc.defaultView;
  if (!win) throw new TypeError("the document has no window");
  const t: Labels = labelsFor(options.locale);
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = "") => {
    const e = doc.createElement(tag);
    if (css) e.style.cssText = css;
    if (text) e.textContent = text;
    return e;
  };

  // Layers: backdrop (covers the whole viewport, frame included) > dialog.
  const backdrop = make(
    "div",
    "position:fixed;inset:0;z-index:2147483600;display:none;align-items:center;justify-content:center;" +
      "padding:16px;box-sizing:border-box;background:rgba(5,6,8,.78)",
  );
  backdrop.setAttribute("data-pptaken-unlock", "");
  const box = make(
    "div",
    "width:100%;max-width:440px;max-height:calc(100% - 32px);overflow:auto;box-sizing:border-box;padding:24px;" +
      `border-radius:10px;background:#181B22;color:#F2EFE9;border:1px solid #3A3F4B;font:15px/1.5 ${SANS};` +
      "box-shadow:0 12px 40px rgba(0,0,0,.5)",
  );
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.id = "pptaken-unlock-dialog";
  const title = make("h2", "margin:0 0 8px;font:600 1.25rem/1.3 " + SANS, t.unlockTitle);
  title.id = "pptaken-unlock-title";
  const text = make("p", "margin:0 0 8px", t.unlockText);
  text.id = "pptaken-unlock-text";
  const notOwner = make("p", "margin:0 0 16px;color:#A3A9B8;font-size:.875rem", t.unlockNotOwner);
  notOwner.id = "pptaken-unlock-not-owner";
  box.setAttribute("aria-labelledby", title.id);
  box.setAttribute("aria-describedby", `${text.id} ${notOwner.id}`);
  const form = make("form", "display:flex;flex-direction:column;gap:8px;margin:0");
  form.noValidate = true;
  const label = make("label", "font-weight:600;font-size:.875rem", t.unlockLabel);
  const input = make(
    "input",
    `min-height:44px;padding:0 12px;border-radius:6px;border:1px solid #565C6B;background:#0F1115;color:#F2EFE9;font:16px ${SANS}`,
  );
  input.type = "password";
  input.id = "pptaken-unlock-password";
  input.name = "presenter-password";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.maxLength = MAX_PASSWORD;
  input.setAttribute("autocapitalize", "off");
  input.setAttribute("aria-describedby", "pptaken-unlock-error");
  label.htmlFor = input.id;
  const error = make("p", "margin:0;min-height:1.5em;color:#FF9F43;font-size:.875rem");
  error.id = "pptaken-unlock-error";
  error.setAttribute("role", "alert");
  error.setAttribute("data-pptaken-unlock-error", "");
  const origin = make(
    "p",
    `margin:4px 0 0;color:#8B8FA0;font:12px/1.4 ${MONO};overflow-wrap:anywhere`,
    win.location.host,
  );
  const actions = make("div", "display:flex;justify-content:flex-end;gap:8px;margin-top:8px");
  const buttonCss =
    `min-height:44px;padding:0 16px;border-radius:6px;font:500 .9375rem/1 ${SANS};cursor:pointer;` +
    "border:1px solid #3A3F4B";
  const cancel = make("button", `${buttonCss};background:#20242D;color:#F2EFE9`, t.unlockCancel);
  cancel.type = "button";
  const submit = make(
    "button",
    `${buttonCss};background:#FFB224;color:#16181D;border-color:#FFB224;font-weight:600`,
    t.unlockSubmit,
  );
  submit.type = "submit";
  actions.append(cancel, submit);
  form.append(label, input, error, actions);
  box.append(title, text, notOwner, form, origin);
  backdrop.append(box);

  const indicator = make(
    "div",
    "position:fixed;top:12px;left:12px;z-index:2147483500;display:none;align-items:center;gap:6px;" +
      `padding:4px 10px;border-radius:999px;background:rgba(0,0,0,.66);color:#FFB224;font:600 12px/1.4 ${SANS};` +
      "border:1px solid rgba(255,178,36,.55);pointer-events:none",
  );
  indicator.setAttribute("role", "status");
  indicator.setAttribute("data-pptaken-interactive", "");
  const indicatorDot = make(
    "span",
    "width:6px;height:6px;border-radius:50%;background:#FFB224;flex:none",
  );
  indicator.append(indicatorDot, doc.createTextNode(t.interactiveOn));
  const toast = make(
    "div",
    "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483500;display:none;" +
      "max-width:calc(100% - 32px);box-sizing:border-box;padding:8px 14px;border-radius:6px;" +
      `background:rgba(0,0,0,.86);color:#F2EFE9;font:14px/1.4 ${SANS};pointer-events:none;text-align:center`,
  );
  toast.setAttribute("role", "status");
  toast.setAttribute("data-pptaken-unlock-notice", "");
  mount.append(backdrop, indicator, toast);

  let isOpen = false;
  let busy = false;
  let destroyed = false;
  let indicatorOn = false;
  let indicatorVisible = true;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let previousFocus: HTMLElement | null = null;
  const inerted: HTMLIFrameElement[] = [];

  const focusables = (): HTMLElement[] =>
    [input, cancel, submit].filter((e) => !(e as HTMLButtonElement).disabled);

  const setError = (message: string): void => {
    error.textContent = message;
  };

  const setBusy = (on: boolean): void => {
    busy = on;
    submit.disabled = on;
    input.disabled = on;
    submit.textContent = on ? t.unlockBusy : t.unlockSubmit;
    if (!on) input.focus({ preventScroll: true });
  };

  const open = (): boolean => {
    if (destroyed || isOpen || !options.available()) return false;
    isOpen = true;
    previousFocus = doc.activeElement as HTMLElement | null;
    for (const frame of options.frames()) {
      if (!frame.inert) {
        frame.inert = true;
        inerted.push(frame);
      }
    }
    setError("");
    input.value = "";
    backdrop.style.display = "flex";
    backdrop.setAttribute("data-open", "true");
    input.focus({ preventScroll: true });
    return true;
  };

  const close = (): void => {
    if (!isOpen) return;
    isOpen = false;
    input.value = "";
    setError("");
    backdrop.style.display = "none";
    backdrop.removeAttribute("data-open");
    for (const frame of inerted.splice(0)) frame.inert = false;
    const target = options.returnFocus?.() ?? previousFocus;
    if (target && target.isConnected) target.focus({ preventScroll: true });
  };

  const onSubmit = async (event: Event): Promise<void> => {
    event.preventDefault();
    if (busy || !isOpen) return;
    const password = input.value;
    input.value = ""; // never kept in the page longer than the request
    if (password === "") {
      setError(t.unlockRequired);
      input.focus({ preventScroll: true });
      return;
    }
    setError("");
    setBusy(true);
    let outcome: UnlockOutcome;
    try {
      outcome = await options.submit(password.slice(0, MAX_PASSWORD));
    } catch {
      outcome = { ok: false, reason: "network" };
    }
    if (!isOpen || destroyed) {
      setBusy(false);
      return;
    }
    if (!outcome.ok) {
      setBusy(false);
      setError(
        outcome.reason === "locked"
          ? outcome.retryAfterSec !== undefined
            ? format(t.unlockLocked, outcome.retryAfterSec)
            : format(t.unlockLocked, 60)
          : outcome.reason === "network"
            ? t.unlockNetwork
            : t.unlockFailed,
      );
      return;
    }
    let running = false;
    try {
      running = await options.onUnlocked(outcome.token);
    } catch {
      running = false;
    }
    setBusy(false);
    if (!running) {
      setError(t.unlockUnavailable);
      return;
    }
    close();
  };

  // Keys inside the dialog never reach the player (no slide changes while typing or on a button).
  const onDialogKey = (event: KeyboardEvent): void => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Tab") {
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0] as HTMLElement;
      const last = items[items.length - 1] as HTMLElement;
      const active = doc.activeElement;
      if (event.shiftKey && (active === first || !box.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !box.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  // Opening: capture phase on the trusted document, before the player sees the key.
  const onDocumentKey = (event: KeyboardEvent): void => {
    if (isOpen) {
      // Focus somehow left the dialog: bring it back, and keep the key from the player.
      if (!box.contains(event.target as Node)) {
        event.preventDefault();
        event.stopPropagation();
        input.focus({ preventScroll: true });
      }
      return;
    }
    if (event.defaultPrevented || !isUnlockKey(event) || isTypingTarget(event.target)) return;
    if (!options.available()) return; // offline: never offered (the presenter view explains why)
    event.preventDefault();
    event.stopPropagation();
    // Open after this key event is fully dispatched: WebKit would otherwise type the "u" into the field.
    setTimeout(() => open(), 0);
  };

  // Focus trap for pointer and programmatic moves too.
  const onFocusIn = (event: FocusEvent): void => {
    if (isOpen && !box.contains(event.target as Node)) input.focus({ preventScroll: true });
  };

  const renderIndicator = (): void => {
    indicator.style.display = indicatorOn && indicatorVisible ? "flex" : "none";
  };

  form.addEventListener("submit", (e) => void onSubmit(e));
  cancel.addEventListener("click", () => close());
  backdrop.addEventListener("keydown", onDialogKey);
  doc.addEventListener("keydown", onDocumentKey, true);
  doc.addEventListener("focusin", onFocusIn, true);

  return {
    open,
    close,
    get isOpen() {
      return isOpen;
    },
    setIndicator(on) {
      indicatorOn = on;
      renderIndicator();
    },
    setIndicatorVisible(visible) {
      indicatorVisible = visible;
      renderIndicator();
    },
    flash(message) {
      toast.textContent = message;
      toast.style.display = "block";
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toast.style.display = "none";
      }, 6000);
    },
    destroy() {
      destroyed = true;
      close();
      clearTimeout(toastTimer);
      doc.removeEventListener("keydown", onDocumentKey, true);
      doc.removeEventListener("focusin", onFocusIn, true);
      backdrop.remove();
      indicator.remove();
      toast.remove();
    },
  };
}
