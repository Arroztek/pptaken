// SPDX-License-Identifier: AGPL-3.0-or-later
// `--open`: opens the default browser on PPTaken's own address. No shell is involved: the program is called with
// an argument vector, by absolute path where the OS has a fixed one, and the URL is validated first.
import { spawn } from "node:child_process";
import { win32 } from "node:path";

const SAFE_URL = /^https?:\/\/[A-Za-z0-9.\-[\]:]+(:\d{1,5})?\/?$/;

export interface OpenCommand {
  command: string;
  args: string[];
}

/** The program and arguments that open `url` on this platform, or null when the URL is not a plain origin. */
export function openCommand(
  url: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): OpenCommand | null {
  if (!SAFE_URL.test(url)) return null;
  if (platform === "win32") {
    const root = env.SystemRoot ?? env.windir;
    const windows = root !== undefined && win32.isAbsolute(root) ? root : "C:\\Windows";
    // explorer.exe hands an http(s) URL to the default browser; no cmd.exe, so no `start` quoting pitfalls.
    return { command: win32.join(windows, "explorer.exe"), args: [url] };
  }
  if (platform === "darwin") return { command: "/usr/bin/open", args: [url] };
  return { command: "xdg-open", args: [url] };
}

/** Best effort: resolves false when the browser could not be started (the address is printed anyway). */
export function openBrowser(url: string): Promise<boolean> {
  const cmd = openCommand(url, process.platform, process.env);
  if (cmd === null) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd.command, cmd.args, {
        stdio: "ignore",
        detached: true,
        shell: false,
        windowsHide: true,
      });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
