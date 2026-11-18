// SPDX-License-Identifier: AGPL-3.0-or-later
// @pptaken/auth-local: authentication for self-hosted instances (security §3): the single owner and its install
// code, password hashing and policy, panel sessions, API tokens, CSRF checks, rate limiting, signed tokens and the
// instance secret, and the OAuth authorization server (ADR-0018). Storage goes through the `AuthStore` and
// `OAuthStore` ports (SQLite adapter in @pptaken/storage-sqlite).

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
  PRESENTER_PASSWORD_SETTING,
  type PresenterPasswordChange,
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
  type AuthorizeOutcome,
  type CimdDocument,
  type CimdFetcher,
  type ConnectedApp,
  createOAuthService,
  OAUTH_ACCESS_TTL_MS,
  OAUTH_CODE_TTL_MS,
  OAUTH_MAX_CLIENTS_WITHOUT_GRANT,
  OAUTH_PENDING_TTL_MS,
  OAUTH_REFRESH_GRACE_MS,
  OAUTH_REFRESH_TTL_MS,
  type OAuthAccess,
  type OAuthErrorCode,
  OAuthProtocolError,
  OAuthService,
  type OAuthServiceOptions,
  type PendingRequestView,
  type TokenResponse,
} from "./oauth.js";
export {
  CLAUDE_CALLBACK,
  canonicalResource,
  displayClientName,
  generateAccessToken,
  generateAuthorizationCode,
  generateRefreshToken,
  isCimdClientId,
  MAX_REDIRECT_URI_LENGTH,
  MAX_REDIRECT_URIS,
  OAUTH_ACCESS_PATTERN,
  OAUTH_ACCESS_PREFIX,
  OAUTH_REFRESH_PATTERN,
  OAUTH_REFRESH_PREFIX,
  OAUTH_REQUEST_ID_PATTERN,
  OAUTH_SCOPES,
  type OAuthScope,
  onlyOAuthScopes,
  parseScopeRequest,
  pkceChallengeOf,
  type RedirectKind,
  redirectKind,
  redirectUriMatches,
  redirectUriProblem,
  verifyPkceS256,
} from "./oauth-primitives.js";
export {
  MemoryOAuthStore,
  type OAuthClientKind,
  type OAuthClientRecord,
  type OAuthCodeRecord,
  type OAuthGrantRecord,
  type OAuthPurgeOptions,
  type OAuthStore,
  type OAuthTokenKind,
  type OAuthTokenRecord,
} from "./oauth-store.js";
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
