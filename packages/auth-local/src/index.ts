// SPDX-License-Identifier: AGPL-3.0-or-later
// @pptaken/auth-local: authentication for self-hosted instances (security §3): the single owner and its install
// code, password hashing and policy, panel sessions, API tokens, CSRF checks, rate limiting, signed tokens and the
// instance secret. Storage goes through the `AuthStore` port (SQLite adapter in @pptaken/storage-sqlite).

export {
  ASSIGNABLE_SCOPES,
  AuthError,
  type AuthErrorCode,
  type Authenticated,
  type AuthProvider,
  type AuthRequest,
  bearerTokenOf,
  createLocalAuth,
  DAY_MS,
  DEFAULT_TOKEN_SCOPES,
  LocalAuth,
  type LocalAuthOptions,
  MAX_TOKEN_EXPIRY_DAYS,
  MAX_TOKEN_NAME_LENGTH,
  type McpStatus,
  SESSION_TTL_MS,
  type TokenView,
} from "./auth.js";
export { isCommonPassword } from "./common-passwords.js";
export {
  constantTimeEqual,
  deriveKey,
  hmacHex,
  type KeyPurpose,
  randomBase64Url,
  sha256Hex,
} from "./crypto.js";
export { CSRF_HEADER, type CsrfInput, type CsrfResult, checkCsrf } from "./csrf.js";
export {
  checkPasswordPolicy,
  DEFAULT_SCRYPT_PARAMS,
  hashPassword,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  needsRehash,
  type PasswordCheck,
  type PasswordProblem,
  type ScryptParams,
  verifyPassword,
} from "./password.js";
export {
  type RateClock,
  type RateDecision,
  SignInThrottle,
  type SignInThrottleOptions,
  TokenBucketLimiter,
  type TokenBucketOptions,
} from "./rate-limit.js";
export { REDACTED, redact, redactString } from "./redact.js";
export {
  type LoadedSecretKey,
  type LoadSecretKeyOptions,
  loadOrCreateSecretKey,
  parseSecretKey,
  SECRET_KEY_FILE,
  SecretKeyError,
} from "./secrets.js";
export {
  type ApiTokenRecord,
  type AuthStore,
  type McpActivityRecord,
  MemoryAuthStore,
  type OwnerRecord,
  type SessionRecord,
  type SetupOutcome,
} from "./store.js";
export {
  API_TOKEN_PATTERN,
  API_TOKEN_PREFIX,
  generateApiToken,
  generateInstallCode,
  generateSessionId,
  hashSecret,
  INSTALL_CODE_ALPHABET,
  isApiTokenFormat,
  normalizeInstallCode,
  SESSION_ID_PATTERN,
  type SignedTokenClaims,
  signToken,
  verifyToken,
} from "./tokens.js";
