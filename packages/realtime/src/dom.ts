// SPDX-License-Identifier: Apache-2.0
// Tiny DOM and HTTP helpers shared by the browser modules. Text is always set with `textContent`; no innerHTML.

export type Attrs = Record<string, string | boolean | undefined>;

/** Creates an element with attributes (`class`, `style`, `data-*`, `aria-*`…) and children. */
export function h<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "string" ? doc.createTextNode(c) : c);
  }
  return el;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`HTTP ${status} ${code}`);
  }
}

/** Same-origin JSON request with the CSRF header (state-changing panel requests need it). */
export async function apiJson<T>(
  fetchImpl: typeof fetch,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: { "X-PPTaken-CSRF": "1", ...headers },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  const res = await fetchImpl(path, init);
  if (!res.ok) {
    let code = "INTERNAL";
    try {
      const j = (await res.json()) as { error?: { code?: unknown } };
      if (typeof j.error?.code === "string") code = j.error.code;
    } catch {
      // not JSON
    }
    throw new HttpError(res.status, code);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Whether a host name is a loopback name or address (the phone cannot reach it). */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
  );
}
