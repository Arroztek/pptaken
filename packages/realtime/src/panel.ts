// SPDX-License-Identifier: Apache-2.0
// The remote-control panel of the laptop (player page and presenter window): the pairing QR code, the LAN address
// picker, the paired devices with approve / remove, "disconnect all", and the approval prompt.
//
// - The QR code is never shown by default: only while the presenter opens the panel (key R, or the button of the
//   presenter window). It encodes `<origin>/r#<secret>`: a one-time 128-bit secret valid for 2 minutes, in the URL
//   fragment (never sent to the server, never in logs). A new code is fetched when it expires while open.
// - Every device needs approval: a pending device shows a prompt "Allow <device> · NN?" confirmed with Enter (or
//   the button) and denied with Escape. The phone shows the same two digits.
// - All actions are HTTP calls with the owner session and the CSRF header; the socket never carries them.
// - The QR is drawn as SVG built node by node from the encoder's module matrix (no markup strings); the matrix
//   already includes the quiet zone.

import { apiJson, HttpError, h, isLoopbackHost } from "./dom.js";
import { fill, type Locale, remoteLabels } from "./i18n.js";
import type { DeviceView } from "./protocol.js";

/** QR encoder: returns the module matrix (`true` = dark) of `text`. */
export type QrEncoder = (text: string) => boolean[][];

export interface LiveInfo {
  liveId: string;
  /** PPTAKEN_PUBLIC_URL when configured, else `null`. */
  publicUrl: string | null;
}

export interface PanelOptions {
  doc: Document;
  /** Element the panel and the prompt are mounted in (the player host, so they stay visible in full screen). */
  mount: HTMLElement;
  locale?: Locale;
  qr: QrEncoder;
  /** Creates (or reuses) the live session of the deck. */
  live(): Promise<LiveInfo>;
  fetch?: typeof fetch;
  /** Poll the device list over HTTP while open (the presenter window has no socket). */
  poll?: boolean;
  /** Called after "disconnect all" succeeded. */
  onKicked?(): void;
  onOpenChange?(open: boolean): void;
}

export interface Panel {
  open(): Promise<void>;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  /** Pushes the device list (the screen's `presence`). Shows the approval prompt for a new pending device. */
  setDevices(devices: readonly DeviceView[]): void;
  /** Approves the device of the visible prompt. */
  approvePrompt(): Promise<void>;
  /** Denies (removes) the device of the visible prompt. */
  denyPrompt(): Promise<void>;
  promptVisible(): boolean;
  kick(): Promise<void>;
  destroy(): void;
}

const SVG = "http://www.w3.org/2000/svg";
/** The encoder adds the quiet zone itself (`border: 4`, the standard four modules). */
const QUIET = 0;
const CODE_REFRESH_MARGIN_MS = 1000;
const POLL_MS = 1500;

const PANEL_CSS =
  "position:absolute;top:16px;right:16px;z-index:20;box-sizing:border-box;width:min(340px,calc(100% - 32px));" +
  "max-height:calc(100% - 32px);overflow:auto;padding:16px;border-radius:8px;background:#16181D;color:#F2EFE9;" +
  "font:14px/1.45 Inter,system-ui,sans-serif;box-shadow:0 8px 32px rgba(0,0,0,.5)";
const PROMPT_CSS =
  "position:absolute;left:50%;top:16px;transform:translateX(-50%);z-index:21;box-sizing:border-box;" +
  "max-width:calc(100% - 32px);padding:12px 16px;border-radius:8px;background:#16181D;color:#F2EFE9;" +
  "font:15px/1.4 Inter,system-ui,sans-serif;box-shadow:0 8px 32px rgba(0,0,0,.5);text-align:center";
const BUTTON_CSS =
  "font:inherit;padding:6px 12px;margin:4px 6px 0 0;border-radius:6px;border:1px solid #3A3F4B;" +
  "background:#22252D;color:#F2EFE9;cursor:pointer";
const MUTED = "color:#8B8FA0";

/** Builds the QR as an SVG element (one path; the matrix includes the quiet zone). */
export function qrSvg(doc: Document, matrix: boolean[][], label: string): SVGSVGElement {
  const n = matrix.length;
  const size = n + QUIET * 2;
  const svg = doc.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.style.cssText = "display:block;width:100%;height:auto;background:#fff;border-radius:4px";
  let d = "";
  matrix.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) d += `M${x + QUIET} ${y + QUIET}h1v1h-1z`;
    });
  });
  const path = doc.createElementNS(SVG, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "#000");
  svg.append(path);
  return svg;
}

export function createPanel(options: PanelOptions): Panel {
  const { doc, mount } = options;
  const win = doc.defaultView as Window;
  const t = remoteLabels(options.locale);
  const fetchImpl = options.fetch ?? win.fetch.bind(win);

  let live: LiveInfo | null = null;
  let isOpen = false;
  let devices: DeviceView[] = [];
  let secret: { value: string; expiresAt: number } | null = null;
  let origins: string[] = [];
  let origin = win.location.origin;
  let tick: ReturnType<typeof setInterval> | undefined;
  let poller: ReturnType<typeof setInterval> | undefined;
  let codeBusy = false;
  /** Pending devices already answered or dismissed (the prompt is shown once per device). */
  const answered = new Set<string>();
  let promptFor: DeviceView | null = null;

  // Panel skeleton.
  const panel = h(doc, "section", {
    role: "dialog",
    "aria-label": t.panelTitle,
    "data-pptaken-remote-panel": "",
    style: PANEL_CSS,
  });
  panel.hidden = true;
  const title = h(doc, "h2", { style: "margin:0 0 8px;font-size:16px" }, t.panelTitle);
  const scan = h(doc, "p", { style: "margin:0 0 8px" }, t.panelScan);
  const lanBox = h(doc, "div", { style: "margin:0 0 8px" });
  const qrBox = h(doc, "div", {
    "data-pptaken-qr": "",
    style: "width:100%;max-width:260px;margin:0 auto 8px",
  });
  const expiry = h(doc, "p", { style: `margin:0 0 4px;${MUTED};font-size:13px` });
  const httpWarn = h(doc, "p", {
    role: "note",
    "data-pptaken-http-warning": "",
    style: "margin:4px 0 8px;color:#FF9F43;font-size:13px",
  });
  httpWarn.hidden = true;
  const error = h(doc, "p", { role: "alert", style: "margin:4px 0;color:#FF6B6B" });
  error.hidden = true;
  const newCode = h(doc, "button", { type: "button", style: BUTTON_CSS }, t.panelNewCode);
  const closeButton = h(doc, "button", { type: "button", style: BUTTON_CSS }, t.panelClose);
  const listTitle = h(doc, "h3", { style: "margin:12px 0 4px;font-size:14px" }, t.panelDevices);
  const list = h(doc, "ul", {
    "data-pptaken-devices": "",
    style: "list-style:none;margin:0;padding:0",
  });
  const kickButton = h(doc, "button", { type: "button", style: BUTTON_CSS }, t.panelKick);
  panel.append(
    title,
    scan,
    lanBox,
    qrBox,
    expiry,
    httpWarn,
    error,
    h(doc, "div", {}, newCode, closeButton),
    listTitle,
    list,
    h(doc, "div", {}, kickButton),
  );

  // Approval prompt (shown even with the panel closed: the presenter just scanned).
  const prompt = h(doc, "div", {
    role: "alertdialog",
    "data-pptaken-remote-prompt": "",
    style: PROMPT_CSS,
  });
  prompt.hidden = true;
  const promptText = h(doc, "div", { style: "font-weight:600" });
  const promptKeys = h(
    doc,
    "div",
    { style: `${MUTED};font-size:13px;margin-top:2px` },
    t.promptKeys,
  );
  const allowButton = h(doc, "button", { type: "button", style: BUTTON_CSS }, t.panelAllow);
  const denyButton = h(doc, "button", { type: "button", style: BUTTON_CSS }, t.panelDeny);
  prompt.append(promptText, promptKeys, h(doc, "div", {}, allowButton, denyButton));
  mount.append(panel, prompt);

  const showError = (text: string | null): void => {
    error.hidden = text === null;
    error.textContent = text ?? "";
  };

  const ensureLive = async (): Promise<LiveInfo> => {
    live ??= await options.live();
    return live;
  };

  const renderQr = (): void => {
    qrBox.replaceChildren();
    if (!secret) return;
    const url = `${origin}/r#${secret.value}`;
    try {
      qrBox.append(qrSvg(doc, options.qr(url), t.panelTitle));
    } catch {
      showError(t.panelError);
    }
    qrBox.dataset.origin = origin;
    httpWarn.hidden = !origin.startsWith("http:");
    httpWarn.textContent = t.panelHttp;
  };

  const renderExpiry = (): void => {
    if (!secret) {
      expiry.textContent = "";
      return;
    }
    const left = Math.max(0, Math.ceil((secret.expiresAt - Date.now()) / 1000));
    expiry.textContent = `${t.panelExpires} ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    if (isOpen && secret.expiresAt - Date.now() < CODE_REFRESH_MARGIN_MS) void refreshCode();
  };

  const refreshCode = async (): Promise<void> => {
    if (codeBusy) return;
    codeBusy = true;
    try {
      const info = await ensureLive();
      const r = await apiJson<{ secret: string; expiresAt: string }>(
        fetchImpl,
        "POST",
        `/api/v1/live/${encodeURIComponent(info.liveId)}/pairing`,
        {},
      );
      secret = { value: r.secret, expiresAt: Date.parse(r.expiresAt) };
      showError(null);
      renderQr();
      renderExpiry();
    } catch (e) {
      secret = null;
      qrBox.replaceChildren();
      showError(e instanceof HttpError && e.status === 404 ? t.panelError : t.panelError);
      if (e instanceof HttpError && e.status === 404) live = null; // the session ended: make a new one
    } finally {
      codeBusy = false;
    }
  };

  const setupOrigins = async (info: LiveInfo): Promise<void> => {
    lanBox.replaceChildren();
    if (info.publicUrl !== null) {
      origin = new URL(info.publicUrl).origin;
      return;
    }
    if (!isLoopbackHost(win.location.hostname)) {
      origin = win.location.origin;
      return;
    }
    try {
      const r = await apiJson<{ addresses: string[] }>(fetchImpl, "GET", "/api/v1/live/lan");
      origins = r.addresses.filter((a) => /^https?:\/\/[0-9a-fA-F:.[\]]+(:\d+)?$/.test(a));
    } catch {
      origins = [];
    }
    if (origins.length === 0) {
      lanBox.append(h(doc, "p", { role: "note", style: "margin:0;color:#FF9F43" }, t.panelNoLan));
      origin = win.location.origin;
      return;
    }
    const select = h(doc, "select", {
      "data-pptaken-lan": "",
      "aria-label": t.panelLoopback,
      style: "width:100%;font:inherit;margin-top:4px",
    });
    for (const o of origins) select.append(h(doc, "option", { value: o }, o));
    origin = origins[0] as string;
    select.addEventListener("change", () => {
      origin = select.value;
      renderQr();
    });
    lanBox.append(h(doc, "p", { role: "note", style: "margin:0" }, t.panelLoopback), select);
  };

  const call = async (method: string, path: string): Promise<void> => {
    const info = await ensureLive();
    await apiJson(fetchImpl, method, `/api/v1/live/${encodeURIComponent(info.liveId)}${path}`, {});
  };

  const approve = async (id: string): Promise<void> => {
    answered.add(id);
    try {
      await call("POST", `/devices/${encodeURIComponent(id)}/approve`);
    } catch {
      showError(t.panelError);
    }
    if (options.poll) await refreshDevices();
  };

  const remove = async (id: string): Promise<void> => {
    answered.add(id);
    try {
      await call("DELETE", `/devices/${encodeURIComponent(id)}`);
    } catch {
      showError(t.panelError);
    }
    if (options.poll) await refreshDevices();
  };

  const renderDevices = (): void => {
    list.replaceChildren();
    if (devices.length === 0) {
      list.append(h(doc, "li", { style: MUTED }, t.panelNoDevices));
    }
    for (const d of devices) {
      const status = d.status === "pending" ? t.panelPending : t.panelApproved;
      const online = d.online ? t.panelOnline : t.panelOffline;
      const li = h(
        doc,
        "li",
        { "data-device": d.id, "data-status": d.status, style: "margin:4px 0" },
        h(doc, "div", {}, `${d.label} · ${d.code}`),
        h(doc, "div", { style: `${MUTED};font-size:13px` }, `${status} · ${online}`),
      );
      const row = h(doc, "div", {});
      if (d.status === "pending") {
        const allow = h(doc, "button", { type: "button", style: BUTTON_CSS }, t.panelAllow);
        allow.addEventListener("click", () => void approve(d.id));
        row.append(allow);
      }
      const rm = h(doc, "button", { type: "button", style: BUTTON_CSS }, t.panelRemove);
      rm.addEventListener("click", () => void remove(d.id));
      row.append(rm);
      li.append(row);
      list.append(li);
    }
    kickButton.disabled = devices.length === 0;
  };

  const renderPrompt = (): void => {
    const pending = devices.find((d) => d.status === "pending" && !answered.has(d.id)) ?? null;
    promptFor = pending;
    prompt.hidden = pending === null;
    if (pending) {
      promptText.textContent = fill(t.promptAllow, { device: pending.label, code: pending.code });
      prompt.dataset.device = pending.id;
    } else {
      delete prompt.dataset.device;
    }
  };

  const setDevices = (next: readonly DeviceView[]): void => {
    devices = next.map((d) => ({ ...d }));
    // A device that left the list may come back as a new id only; forget answered ids no longer listed.
    for (const id of answered) if (!devices.some((d) => d.id === id)) answered.delete(id);
    renderDevices();
    renderPrompt();
  };

  const refreshDevices = async (): Promise<void> => {
    if (!live) return;
    try {
      const r = await apiJson<{ devices: DeviceView[] }>(
        fetchImpl,
        "GET",
        `/api/v1/live/${encodeURIComponent(live.liveId)}/devices`,
      );
      setDevices(r.devices);
    } catch {
      // keep the last list
    }
  };

  const kick = async (): Promise<void> => {
    try {
      await call("POST", "/kick");
      for (const d of devices) answered.add(d.id);
      setDevices([]);
      options.onKicked?.();
    } catch {
      showError(t.panelError);
    }
  };

  const open = async (): Promise<void> => {
    if (isOpen) return;
    isOpen = true;
    panel.hidden = false;
    options.onOpenChange?.(true);
    renderDevices();
    try {
      const info = await ensureLive();
      await setupOrigins(info);
    } catch {
      showError(t.panelError);
      return;
    }
    if (!isOpen) return;
    await refreshCode();
    win.clearInterval(tick);
    tick = win.setInterval(renderExpiry, 1000);
    if (options.poll) {
      await refreshDevices();
      win.clearInterval(poller);
      poller = win.setInterval(() => void refreshDevices(), POLL_MS);
    }
  };

  const close = (): void => {
    if (!isOpen) return;
    isOpen = false;
    panel.hidden = true;
    win.clearInterval(tick);
    win.clearInterval(poller);
    // The code is useless once nobody sees it; it expires by itself within 2 minutes.
    secret = null;
    qrBox.replaceChildren();
    options.onOpenChange?.(false);
  };

  newCode.addEventListener("click", () => void refreshCode());
  closeButton.addEventListener("click", close);
  kickButton.addEventListener("click", () => void kick());
  allowButton.addEventListener("click", () => {
    if (promptFor) void approve(promptFor.id).then(renderPrompt);
  });
  denyButton.addEventListener("click", () => {
    if (promptFor) void remove(promptFor.id).then(renderPrompt);
  });
  renderDevices();

  return {
    open,
    close,
    toggle: () => {
      if (isOpen) close();
      else void open();
    },
    isOpen: () => isOpen,
    setDevices,
    approvePrompt: async () => {
      const d = promptFor;
      if (!d) return;
      answered.add(d.id);
      renderPrompt();
      await approve(d.id);
    },
    denyPrompt: async () => {
      const d = promptFor;
      if (!d) return;
      answered.add(d.id);
      renderPrompt();
      await remove(d.id);
    },
    promptVisible: () => !prompt.hidden,
    kick,
    destroy: () => {
      close();
      panel.remove();
      prompt.remove();
    },
  };
}
