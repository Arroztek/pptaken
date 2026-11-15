// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared fixtures: an isolated mock server per test, a stubbed clipboard, and guards that fail the
// test on requests outside the app origin, console errors and CSP violations.
import { test as base, expect, type Page } from "@playwright/test";
import { OWNER_PASSWORD, startMockServer } from "../mock-server.mjs";

export { expect, OWNER_PASSWORD };

export type MockOptions = NonNullable<Parameters<typeof startMockServer>[0]>;
export type Mock = Awaited<ReturnType<typeof startMockServer>>;

declare global {
  interface Window {
    __clip: { text: string | null; writes: number };
    __csp: string[];
  }
}

/** Expected noise: browsers log non-2xx fetches (401 from /auth/me, 4xx in error-path tests). */
const EXPECTED_CONSOLE =
  /Failed to load resource: the server responded with a status of (400|401|403|404|409|429)/;

export const test = base.extend<{ mockOptions: MockOptions; mock: Mock }>({
  mockOptions: [{}, { option: true }],
  mock: async ({ mockOptions }, use) => {
    const mock = await startMockServer(mockOptions);
    await use(mock);
    await mock.close();
  },
  page: async ({ page, mock }, use) => {
    const origin = new URL(mock.url).origin;
    const external: string[] = [];
    const errors: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.protocol === "data:" || url.protocol === "blob:") return;
      if (url.origin !== origin) external.push(request.url());
    });
    page.on("console", (message) => {
      if (message.type() === "error" && !EXPECTED_CONSOLE.test(message.text()))
        errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.__csp = [];
      document.addEventListener("securitypolicyviolation", (e) => {
        window.__csp.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`);
      });
      // Deterministic clipboard in every engine (no permission prompts, readable from the test).
      const store = { text: null as string | null, writes: 0 };
      window.__clip = store;
      const clipboard = {
        async writeText(text: string) {
          store.text = String(text);
          store.writes++;
        },
        async write(items: ClipboardItem[]) {
          const blob = await items[0]?.getType("text/plain");
          store.text = blob ? await blob.text() : null;
          store.writes++;
        },
        async readText() {
          return store.text ?? "";
        },
      };
      Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
    });

    await use(page);

    const csp = page.isClosed()
      ? []
      : await page.evaluate(() => window.__csp ?? []).catch(() => []);
    expect(external, "requests outside the app origin").toEqual([]);
    expect(errors, "console errors").toEqual([]);
    expect(csp, "CSP violations").toEqual([]);
  },
});

export async function clipboardText(page: Page): Promise<string | null> {
  return page.evaluate(() => window.__clip.text);
}

/** Sign in through the API (the cookie lands in the page's browser context). */
export async function signIn(page: Page, mock: Mock): Promise<void> {
  const response = await page.request.post(`${mock.url}/api/v1/auth/login`, {
    headers: { "X-PPTaken-CSRF": "1", Origin: mock.url },
    data: { password: OWNER_PASSWORD },
  });
  expect(response.status()).toBe(200);
}

export async function noHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "horizontal overflow in px").toBeLessThanOrEqual(0);
}
