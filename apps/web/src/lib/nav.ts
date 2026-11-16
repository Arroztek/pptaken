// SPDX-License-Identifier: AGPL-3.0-or-later
// The sidebar's navigation: groups of pages, in display order. Pure data so the shell, the tests and future
// pages share one list.
import type { IconName } from "@pptaken/ui";
import { normalizePath } from "./router";
import type { Key } from "./translate";

export interface NavItem {
  /** An app path handled by router.ts. */
  href: string;
  label: Key;
  icon: IconName;
}

export interface NavGroup {
  id: string;
  label: Key;
  items: readonly NavItem[];
}

/**
 * Only pages that exist are listed (no dead links). Upcoming groups slot in between Workspace and Account once
 * their pages ship, each with a label in both dictionaries, a route in router.ts and an icon in @pptaken/ui:
 *   { id: "audience", label: "nav.groupAudience", items: [questions (/questions), quizzes (/quizzes)] }
 *   { id: "sharing", label: "nav.groupSharing", items: [links (/sharing)] }
 * Settings would join the Account group.
 */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: "workspace",
    label: "nav.groupWorkspace",
    items: [
      { href: "/decks", label: "nav.decks", icon: "presentation" },
      { href: "/welcome", label: "nav.connect", icon: "plug" },
    ],
  },
  {
    id: "account",
    label: "nav.groupAccount",
    items: [
      { href: "/tokens", label: "nav.tokens", icon: "key" },
      { href: "/security", label: "nav.security", icon: "shield-check" },
    ],
  },
];

export function isActive(item: NavItem, path: string): boolean {
  return normalizePath(path) === item.href;
}
