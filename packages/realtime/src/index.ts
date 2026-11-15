// SPDX-License-Identifier: Apache-2.0
// @pptaken/realtime: the remote control (phase F4).
//
// - protocol (shared): frame types and hand-written validators, version 1.
// - reducer + hub (server): the pure live-session reducer and the in-memory RealtimeHub that runs it.
// - limits (shared): token buckets, backoff, keepalive timings.
// - browser modules (served as ES modules from /_rt/): client (reconnecting socket), screen (player page),
//   panel (pairing QR, approvals, kick), phone (the /r page).

export { RealtimeHub, type Sink } from "./hub.js";
export { pickRemoteLocale, REMOTE_LABELS, remoteLabels } from "./i18n.js";
export {
  AUTH_TIMEOUT_MS,
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  backoffDelay,
  PING_INTERVAL_MS,
  PING_MISSES,
  RATES,
  TokenBucket,
} from "./limits.js";
export { PHONE_CSS, toCoord } from "./phone.js";
export {
  ACTIONS,
  type Action,
  ALLOWED,
  CLOSE,
  type ClientFrame,
  COORD_MAX,
  type DeviceStatus,
  type DeviceView,
  decodeFrame,
  encodeFrame,
  isDeviceLabel,
  MAX_CREDENTIAL,
  MAX_FRAME_BYTES,
  MAX_LABEL,
  MAX_PRESENCE,
  MAX_SLIDES,
  MAX_STEPS,
  parseClientFrame,
  parseToRemote,
  parseToScreen,
  REALTIME_VERSION,
  ROLES,
  type Role,
  type ScreenState,
  type ServerFrame,
  type ToRemote,
  type ToScreen,
} from "./protocol.js";
export {
  type Connection,
  type DeviceInfo,
  type Effect,
  emptyRoom,
  presenceOf,
  type Reduction,
  type RoomEvent,
  type RoomState,
  reduce,
} from "./reducer.js";

/** Browser modules of this package served by the server under `/_rt/` (ES modules, relative imports only). */
export const BROWSER_FILES = [
  "client.js",
  "dom.js",
  "i18n.js",
  "limits.js",
  "panel.js",
  "phone.js",
  "protocol.js",
  "screen.js",
] as const;
