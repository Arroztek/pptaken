// SPDX-License-Identifier: Apache-2.0
// @pptaken/player: the presentation player engine (phase F1, minimal player).
//
// - builder (server): `buildDeckDocument` turns a sanitized deck into the content document; `contentHeaders`,
//   `contentSecurityPolicy` and `assetHeaders` give the headers of the content route.
// - shell (browser, trusted page): `createPlayer` mounts the document in a sandboxed iframe and drives it.
// - protocol and navigation: shared, pure, testable without a browser.
// Browser code should import `@pptaken/player/shell`, which does not pull the builder or `@pptaken/schema`.

export { type BuildOptions, buildDeckDocument, type DeckDocument, escapeHtml } from "./builder.js";
export {
  assetHeaders,
  type CspOptions,
  contentHeaders,
  contentSecurityPolicy,
  PERMISSIONS_POLICY,
} from "./csp.js";
export { KEY_CODES, type KeyCode, type KeyLike, keyCodeOf } from "./keys.js";
export * as navigation from "./navigation.js";
export { type DeckShape, KEY_ACTIONS, type KeyAction, type Position } from "./navigation.js";
export {
  type ContentMessage,
  type GotoMessage,
  isBoundedInt,
  type KeyMessage,
  MAX_SLIDES,
  MAX_STEPS,
  MODES,
  type Mode,
  type ModeMessage,
  PROTOCOL_VERSION,
  parseContentMessage,
  parseShellMessage,
  type ReadyMessage,
  type ShellMessage,
  SLIDE_ID_PATTERN,
  type SlideInfo,
  type StateMessage,
} from "./protocol.js";
export { RUNTIME_SOURCE } from "./runtime-source.js";
export {
  createPlayer,
  type Player,
  type PlayerFault,
  type PlayerOptions,
  type PlayerState,
} from "./shell.js";
