// SPDX-License-Identifier: AGPL-3.0-or-later
// Where `npx pptaken` keeps its data by default: the per-user application data folder of each operating system,
// never the current directory (npx runs from anywhere, and a later run from another folder must find the same data).
// Pure: the platform, environment and home directory are injected, so every platform is unit tested on any OS.
import { accessSync, constants, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { posix, resolve, win32 } from "node:path";

export interface PlatformContext {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  homedir: string;
}

/**
 * - Windows: `%LOCALAPPDATA%\PPTaken` (local, not roaming: a database must not be synced between machines).
 * - macOS: `~/Library/Application Support/PPTaken`.
 * - Linux and others: `$XDG_DATA_HOME/pptaken` when it is an absolute path (XDG Base Directory spec), otherwise
 *   `~/.local/share/pptaken`.
 */
export function defaultDataDir({ platform, env, homedir }: PlatformContext): string {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    const base =
      local !== undefined && local !== "" && win32.isAbsolute(local)
        ? local
        : win32.join(homedir, "AppData", "Local");
    return win32.join(base, "PPTaken");
  }
  if (platform === "darwin") {
    return posix.join(homedir, "Library", "Application Support", "PPTaken");
  }
  const xdg = env.XDG_DATA_HOME;
  const base =
    xdg !== undefined && xdg !== "" && posix.isAbsolute(xdg)
      ? xdg
      : posix.join(homedir, ".local", "share");
  return posix.join(base, "pptaken");
}

export type DataDirSource = "option" | "environment" | "default";

/** `--data-dir` wins over PPTAKEN_DATA_DIR, which wins over the per-OS default. Relative paths use the cwd. */
export function resolveDataDir(
  option: string | undefined,
  ctx: PlatformContext,
): { path: string; source: DataDirSource } {
  if (option !== undefined) return { path: resolve(option), source: "option" };
  const fromEnv = ctx.env.PPTAKEN_DATA_DIR;
  if (fromEnv !== undefined && fromEnv !== "")
    return { path: resolve(fromEnv), source: "environment" };
  return { path: defaultDataDir(ctx), source: "default" };
}

/** The data folder cannot be created or written: the message says which folder and what to do. */
export class DataDirError extends Error {
  override readonly name = "DataDirError";
}

/**
 * Creates the folder (owner-only permissions where the OS supports them) and proves it is writable with a probe
 * file, so the server does not fail later with a raw SQLite error.
 */
export function ensureWritableDataDir(path: string): void {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new DataDirError(describe(path, error, "create"));
  }
  try {
    if (!statSync(path).isDirectory()) {
      throw new DataDirError(
        `${path} exists but is a file, not a folder. Choose another --data-dir.`,
      );
    }
    accessSync(path, constants.W_OK);
    const probe = resolve(path, `.pptaken-write-test-${process.pid}`);
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
  } catch (error) {
    if (error instanceof DataDirError) throw error;
    throw new DataDirError(describe(path, error, "write to"));
  }
}

function describe(path: string, error: unknown, action: string): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const why =
    code === "EACCES" || code === "EPERM"
      ? "you do not have permission"
      : code === "EROFS"
        ? "the disk is read-only"
        : code === "ENOSPC"
          ? "the disk is full"
          : code === "ENOTDIR" || code === "EEXIST"
            ? "part of the path is a file, not a folder"
            : (code ?? "unknown error");
  return `PPTaken cannot ${action} its data folder ${path} (${why}). Choose a folder you own with --data-dir, for example --data-dir ./pptaken-data.`;
}
