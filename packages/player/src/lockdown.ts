// SPDX-License-Identifier: Apache-2.0
// Script-mode lockdown (ADR-020), compiled into the runtime and run from <head> before any author script exists.
// It removes every channel spike S5 (and the integrity-hash probe of ADR-020) showed an author script could use
// to send data out or to load code: WebRTC and the other network constructors, beacons, workers, popups, and the
// creation or parsing of elements that fetch scripts (`<script>`, `<link>`, `<meta>`, frames...). Properties
// become non-configurable, so later code cannot put them back, and the browser gives the content no fresh realm
// to fetch pristine copies from (child frames cannot be created, and the sandbox already blocked them in S5).
//
// This is one JavaScript barrier on top of the CSP (`connect-src 'none'`, hash-only `script-src`,
// `worker-src 'none'`, Trusted Types) and the sandbox, never instead of them. No imports: it is bundled into the
// runtime IIFE by scripts/build-runtime.mjs.

/** Window globals removed in script mode: network, workers, popups, cross-context messaging, XSLT, custom elements. */
export const LOCKED_GLOBALS: readonly string[] = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "WebSocketStream",
  "EventSource",
  "WebTransport",
  "Worker",
  "SharedWorker",
  "importScripts",
  "BroadcastChannel",
  "open",
  "XSLTProcessor",
  "PresentationRequest",
  "customElements",
  "RTCPeerConnection",
  "webkitRTCPeerConnection",
  "mozRTCPeerConnection",
  "RTCDataChannel",
  "RTCIceCandidate",
  "RTCSessionDescription",
  "RTCIceTransport",
  "RTCRtpSender",
  "RTCRtpReceiver",
  "RTCRtpTransceiver",
];

/** `navigator` members removed in script mode (beacons, network info, devices, sharing, clipboard). */
export const LOCKED_NAVIGATOR: readonly string[] = [
  "sendBeacon",
  "connection",
  "presentation",
  "share",
  "canShare",
  "clipboard",
  "credentials",
  "serviceWorker",
  "bluetooth",
  "usb",
  "hid",
  "serial",
  "mediaDevices",
  "geolocation",
  "requestMIDIAccess",
  "registerProtocolHandler",
];

/**
 * Elements author code may not create, by any API: those that fetch or run scripts (a hash source also authorizes
 * an external script or preload whose `integrity` names it), navigate or embed, or change how the document is
 * interpreted.
 */
export const FORBIDDEN_ELEMENTS: readonly string[] = [
  "script",
  "link",
  "meta",
  "base",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "portal",
  "fencedframe",
  "form",
];

/** HTML strings that would create one of {@link FORBIDDEN_ELEMENTS} when parsed (case-insensitive). */
export const FORBIDDEN_MARKUP =
  /<\s*(?:script|link|meta|base|i?frame|frameset|object|embed|portal|fencedframe|form)\b/i;

type Anything = Record<string, unknown>;

/** Runs the lockdown. Returns the names that could not be locked (for tests; empty in the measured engines). */
export function lockdown(win: Window, doc: Document): string[] {
  const failed: string[] = [];
  const apply = Reflect.apply;
  const define = Object.defineProperty;
  const getDescriptor = Object.getOwnPropertyDescriptor;
  const getNames = Object.getOwnPropertyNames;
  // Every check below runs later, after author code may have replaced built-in prototype methods: it only calls
  // functions captured now, through the captured `Reflect.apply`, and passes arguments as array literals (whose
  // elements are own properties, so no inherited accessor is consulted).
  const forbidden = new Set(FORBIDDEN_ELEMENTS);
  const setHas = Set.prototype.has;
  const exec = RegExp.prototype.exec;
  const toLower = String.prototype.toLowerCase;
  const indexOf = String.prototype.indexOf;
  const slice = String.prototype.slice;
  const markup = new RegExp(FORBIDDEN_MARKUP.source, FORBIDDEN_MARKUP.flags);
  const isMarkup = (text: string): boolean => apply(exec, markup, [text]) !== null;

  const kill = (target: object | null | undefined, name: string): void => {
    if (target === null || target === undefined) return;
    try {
      define(target, name, {
        value: undefined,
        writable: false,
        enumerable: false,
        configurable: false,
      });
    } catch {
      failed.push(name);
    }
  };
  /** Replaces a method with a checked wrapper, non-configurable and non-writable. */
  const wrap = (
    target: object | null | undefined,
    name: string,
    make: (original: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown,
  ): void => {
    if (target === null || target === undefined) return;
    const d = getDescriptor(target, name);
    if (d === undefined || typeof d.value !== "function") return;
    try {
      define(target, name, {
        value: make(d.value as (...args: unknown[]) => unknown),
        writable: false,
        enumerable: d.enumerable ?? false,
        configurable: false,
      });
    } catch {
      failed.push(name);
    }
  };
  /** Replaces an accessor's setter with a checked one (the getter is kept). */
  const wrapSetter = (
    target: object | null | undefined,
    name: string,
    check: (value: unknown) => unknown,
  ): void => {
    if (target === null || target === undefined) return;
    const d = getDescriptor(target, name);
    if (d === undefined || typeof d.set !== "function") return;
    const set = d.set;
    try {
      define(target, name, {
        ...(d.get === undefined ? {} : { get: d.get }),
        set(this: unknown, value: unknown) {
          apply(set, this, [check(value)]);
        },
        enumerable: d.enumerable ?? false,
        configurable: false,
      });
    } catch {
      failed.push(name);
    }
  };

  // Trusted Types where supported: the native, complete list of script and HTML sinks. The `default` policy is
  // the only one the CSP allows (`trusted-types default`); creating it here, first, means author code cannot.
  const tt = (win as unknown as { trustedTypes?: { createPolicy?: unknown } }).trustedTypes;
  let ttHtml: ((value: unknown) => boolean) | null = null;
  if (tt && typeof tt.createPolicy === "function") {
    try {
      const policy = apply(tt.createPolicy, tt, [
        "default",
        {
          createHTML: (value: string, _type: string, sink: string) =>
            sink === "Document write" || sink === "Document writeln" || isMarkup(`${value}`)
              ? null
              : value,
          createScript: () => null,
          createScriptURL: () => null,
        },
      ]) as object;
      const isHTML = (tt as { isHTML?: unknown }).isHTML;
      if (policy && typeof isHTML === "function") {
        ttHtml = (value) => apply(isHTML, tt, [value]) === true;
      }
    } catch {
      failed.push("trustedTypes.default");
    }
  }

  /** HTML strings for the parsing entry points (also where Trusted Types is missing). */
  const checkHtml = (value: unknown): unknown => {
    if (ttHtml?.(value)) return value; // already vetted by the default policy
    const text = `${value}`;
    if (isMarkup(text)) throw new TypeError("PPTaken: this element cannot be created in a slide");
    return text;
  };
  const checkName = (value: unknown): string => {
    const name = `${value}`;
    const colon = apply(indexOf, name, [":"]) as number;
    const local = apply(toLower, colon < 0 ? name : apply(slice, name, [colon + 1]), []) as string;
    if (apply(setHas, forbidden, [local])) {
      throw new TypeError("PPTaken: this element cannot be created in a slide");
    }
    return name;
  };

  // 1. Network, workers, popups, WebRTC (every RTC* name the engine has, prefixed or not).
  const names = new Set(LOCKED_GLOBALS);
  for (const name of getNames(win)) if (/^(?:webkit|moz)?RTC/.test(name)) names.add(name);
  for (const name of names) kill(win, name);

  // 2. navigator: on the prototype (the getters and methods live there) and on the instance.
  const nav = win.navigator;
  const navProto = Object.getPrototypeOf(nav) as object | null;
  for (const name of LOCKED_NAVIGATOR) {
    kill(navProto, name);
    kill(nav, name);
  }

  // 3. Element creation: no script, link, meta, base, frames, objects or forms by name.
  const docProto = (win as unknown as Anything).Document as { prototype: object } | undefined;
  wrap(
    docProto?.prototype,
    "createElement",
    (original) =>
      function (this: unknown, name: unknown, options: unknown) {
        return apply(original, this, [checkName(name), options]);
      },
  );
  wrap(
    docProto?.prototype,
    "createElementNS",
    (original) =>
      function (this: unknown, ns: unknown, name: unknown, options: unknown) {
        return apply(original, this, [ns, checkName(name), options]);
      },
  );

  // 4. Parsing entry points (Trusted Types covers them natively; these also work where it is missing).
  const proto = (name: string): object | undefined =>
    ((win as unknown as Anything)[name] as { prototype?: object } | undefined)?.prototype;
  for (const target of [proto("Element"), proto("ShadowRoot")]) {
    wrapSetter(target, "innerHTML", checkHtml);
    wrapSetter(target, "outerHTML", checkHtml);
  }
  const firstArg = (original: (...args: unknown[]) => unknown) =>
    function (this: unknown, html: unknown, second: unknown) {
      return apply(original, this, [checkHtml(html), second]);
    };
  wrap(
    proto("Element"),
    "insertAdjacentHTML",
    (original) =>
      function (this: unknown, position: unknown, html: unknown) {
        return apply(original, this, [position, checkHtml(html)]);
      },
  );
  wrap(proto("Element"), "setHTMLUnsafe", firstArg);
  wrap(proto("ShadowRoot"), "setHTMLUnsafe", firstArg);
  wrap(proto("Range"), "createContextualFragment", firstArg);
  wrap(proto("DOMParser"), "parseFromString", firstArg);
  wrap((win as unknown as Anything).Document as object, "parseHTMLUnsafe", firstArg);
  for (const name of ["write", "writeln", "open", "execCommand"]) {
    kill(docProto?.prototype, name);
    kill(doc, name);
  }
  return failed;
}
