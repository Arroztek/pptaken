// SPDX-License-Identifier: AGPL-3.0-or-later
// The sidebar's navigation: groups of pages, in display order. Pure data so the shell, the tests and future
// pages share one list. Labels are plain words (no "tokens", no "MCP").
import type { IconName } from "@pptaken/ui";
import { normalizePath } from "./router";
import type { Key } from "./translate";

export interface NavItem {
  /** An app path handled by router.ts. */
  href: string;
  label: Key;
  icon: IconName;
  /** Other paths that belong to this item (old addresses, sub-pages). */
  also?: readonly string[];
}

export interface NavGroup {
  id: string;
  label: Key;
  items: readonly NavItem[];
}

/**
 * Only pages that exist are listed (no dead links). Upcoming groups slot in between Workspace and Account once
 * their pages ship, each with a label in both dictionaries, a route in router.ts and an icon in @pptaken/ui.
 */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: "workspace",
    label: "nav.groupWorkspace",
    items: [
      { href: "/decks", label: "nav.decks", icon: "presentation", also: ["/trash"] },
      { href: "/welcome", label: "nav.connect", icon: "plug" },
    ],
  },
  {
    id: "account",
    label: "nav.groupAccount",
    items: [
      { href: "/apps", label: "nav.apps", icon: "squares-four", also: ["/tokens"] },
      { href: "/security", label: "nav.security", icon: "shield-check" },
      { href: "/settings", label: "nav.settings", icon: "sliders" },
    ],
  },
];

/** The item of the current page; a presentation's page (`/decks/<id>`) and the trash belong to Presentations. */
export function isActive(item: NavItem, path: string): boolean {
  const clean = normalizePath(path);
  return (
    clean === item.href ||
    (item.also ?? []).includes(clean) ||
    (item.href === "/decks" && clean.startsWith("/decks/"))
  );
}
