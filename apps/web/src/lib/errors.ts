// SPDX-License-Identifier: AGPL-3.0-or-later
// Translate API errors by code (the server's English message is never shown as-is).
import { ApiError } from "./api";
import type { T } from "./translate";

/** Where the error happened: the same code reads differently on the setup and login forms. */
export type ErrorContext = "setup" | "login" | "general";

export function errorMessage(error: unknown, t: T, context: ErrorContext = "general"): string {
  if (!(error instanceof ApiError)) return t("errors.unexpected");
  switch (error.code) {
    case "VALIDATION_ERROR":
      return t("errors.validation");
    case "UNAUTHENTICATED":
      return context === "login" ? t("errors.wrongPassword") : t("errors.sessionEnded");
    case "FORBIDDEN":
      return context === "setup" ? t("errors.wrongCode") : t("errors.forbidden");
    case "NOT_FOUND":
      return t("errors.notFound");
    case "SETUP_REQUIRED":
      return t("errors.setupRequired");
    case "ALREADY_SETUP":
      return t("errors.alreadySetup");
    case "RATE_LIMITED":
      return error.retryAfter
        ? t("errors.rateLimited", { n: error.retryAfter })
        : t("errors.rateLimitedSoon");
    case "NETWORK":
      return t("errors.network");
    case "INTERNAL":
      return t("errors.internal");
    default:
      return t("errors.unexpected");
  }
}
