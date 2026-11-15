// SPDX-License-Identifier: Apache-2.0
// @pptaken/player: the presentation player engine (phase F1, minimal player).
//
// - builder (server): `buildDeckDocument` turns a sanitized deck into the content document; `contentHeaders`,
//   `contentSecurityPolicy` and `assetHeaders` give the headers of the content route.
// - shell (browser, trusted page): `createPlayer` mounts the document in a sandboxed iframe and drives it.
// - protocol and navigation: shared, pure, testable without a browser.
// Browser code should import `@pptaken/player/shell`, which does not pull the builder or `@pptaken/schema`.

export {
  type BuildOptions,
  buildDeckDocument,
  type DeckDocument,
  escapeHtml,
  type FontFaceSpec,
} from "./builder.js";
export {
  assetHeaders,
  type CspOptions,
  contentHeaders,
  contentSecurityPolicy,
  PERMISSIONS_POLICY,
} from "./csp.js";
export { LABELS, type LabelKey, type Labels, type Locale, labelsFor, pickLocale } from "./i18n.js";
export { type KeyCode, type KeyLike, keyCodeOf } from "./keys.js";
export {
  LASER_COORD_MAX,
  LASER_SIZE,
  LASER_TIMEOUT_MS,
  type LaserGeometry,
  laserGeometry,
} from "./laser.js";
export * as navigation from "./navigation.js";
export {
  type DeckShape,
  KEY_ACTIONS,
  type KeyAction,
  overviewMove,
  type Position,
} from "./navigation.js";
export { NOTES_MAX_INPUT, NOTES_TAGS, renderInline, renderNotes } from "./notes.js";
export {
  isOfflineDocument,
  OFFLINE_DOCUMENT_CSP,
  OFFLINE_STATES,
  type OfflineState,
  type OfflineStatus,
  offlineStateOf,
  offlineStatus,
} from "./offline.js";
export {
  BUILD_PLACEHOLDER,
  CACHE_PREFIX,
  SHELL_FILES,
  SW_SCOPE,
  SW_URL,
} from "./offline-cache.js";
export {
  buildOfflineDocument,
  type OfflineAsset,
  type OfflineDocument,
  type OfflineDocumentOptions,
  type OfflineFont,
} from "./offline-document.js";
export * as pace from "./pace.js";
export {
  type PresenterData,
  type PresenterSlide,
  parsePresenterData,
} from "./presenter-data.js";
export {
  type ContentMessage,
  type GotoMessage,
  isBoundedInt,
  KEY_CODES,
  type KeyMessage,
  MAX_CANVAS,
  MAX_PRELOAD_COUNT,
  MAX_PRELOAD_FAILED,
  MAX_SLIDES,
  MAX_STEPS,
  MODES,
  type Mode,
  type ModeMessage,
  overviewColumns,
  PRELOAD_FAILURES,
  PROTOCOL_VERSION,
  type PreloadFailure,
  type PreloadMessage,
  parseContentMessage,
  parseShellMessage,
  type ReadyMessage,
  type SelectMessage,
  type ShellMessage,
  SLIDE_ID_PATTERN,
  type SlideInfo,
  type StateMessage,
} from "./protocol.js";
export { RUNTIME_SHA256, RUNTIME_SOURCE } from "./runtime-source.js";
export {
  createPlayer,
  type KeySource,
  type Player,
  type PlayerFault,
  type PlayerOptions,
  type PlayerState,
  PRESENTER_WINDOW,
} from "./shell.js";
export {
  openSync,
  parseSyncMessage,
  SYNC_CHANNEL_PATTERN,
  SYNC_VERSION,
  type Sync,
  type SyncMessage,
  syncChannelName,
} from "./sync.js";
