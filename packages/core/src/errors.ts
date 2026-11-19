// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Stable error codes of the domain, matching the MCP error catalog (`docs/foundation/02-architecture.md` §5.4).
 * Never rename a code: agents and clients depend on them.
 *
 * The core throws `VALIDATION_ERROR`, `NOT_FOUND`, `REVISION_CONFLICT`, `LIMIT_EXCEEDED`, `UNSUPPORTED_MEDIA`,
 * `FORBIDDEN_SCOPE`, `FORBIDDEN_ACTOR` and `INTERNAL`. `FETCH_FAILED`, `FETCH_BLOCKED` and `RATE_LIMITED` are
 * part of the catalog so that outer layers (URL fetching, rate limiting) can reuse {@link DomainError}.
 */
export const ERROR_CODES = [
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "REVISION_CONFLICT",
  "LIMIT_EXCEEDED",
  "UNSUPPORTED_MEDIA",
  "FORBIDDEN_SCOPE",
  "FORBIDDEN_ACTOR",
  "FETCH_FAILED",
  "FETCH_BLOCKED",
  "RATE_LIMITED",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Serializable body of an error, the shape returned to agents (`{ code, message, path?, hint, retryable }`). */
export interface DomainErrorBody {
  code: ErrorCode;
  message: string;
  path?: string;
  /** Written for an LLM that must correct its call: says what to do next. */
  hint: string;
  retryable: boolean;
  /** Extra machine-readable facts, e.g. `{ currentRevision: 7 }` or `{ limit: 200, received: 250 }`. */
  details?: Record<string, unknown>;
}

export interface DomainErrorInit {
  path?: string | undefined;
  hint: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
}

/** The only error type use cases throw. Anything else that escapes a use case is wrapped as `INTERNAL`. */
export class DomainError extends Error {
  override readonly name = "DomainError";
  readonly code: ErrorCode;
  readonly path: string | undefined;
  readonly hint: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, init: DomainErrorInit) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.code = code;
    this.path = init.path;
    this.hint = init.hint;
    this.retryable = init.retryable ?? false;
    this.details = init.details;
  }

  /** The agent-facing body. Never includes the cause or a stack trace. */
  toJSON(): DomainErrorBody {
    const body: DomainErrorBody = {
      code: this.code,
      message: this.message,
      hint: this.hint,
      retryable: this.retryable,
    };
    if (this.path !== undefined) body.path = this.path;
    if (this.details !== undefined) body.details = { ...this.details };
    return body;
  }
}

/**
 * True for a {@link DomainError}, also across duplicated copies of this package (checks the shape, not only the
 * prototype chain).
 */
export function isDomainError(value: unknown): value is DomainError {
  if (value instanceof DomainError) return true;
  if (typeof value !== "object" || value === null) return false;
  const v = value as { name?: unknown; code?: unknown; hint?: unknown };
  return (
    v.name === "DomainError" &&
    typeof v.code === "string" &&
    (ERROR_CODES as readonly string[]).includes(v.code) &&
    typeof v.hint === "string"
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Constructors with consistent, agent-oriented hints.

export function validationError(
  message: string,
  init: { path?: string | undefined; hint?: string; details?: Record<string, unknown> } = {},
): DomainError {
  return new DomainError("VALIDATION_ERROR", message, {
    path: init.path,
    hint:
      init.hint ??
      "Fix the field named in `path` and call again. Call `get_authoring_guide` for the format.",
    ...(init.details === undefined ? {} : { details: init.details }),
  });
}

export function presentationNotFound(presentationId: string): DomainError {
  return new DomainError("NOT_FOUND", `Presentation "${clip(presentationId)}" does not exist`, {
    path: "presentationId",
    hint: "Use `list_presentations` to get valid ids. Presentations in the trash are not visible.",
  });
}

export function notFound(
  message: string,
  init: { path?: string; hint: string; details?: Record<string, unknown> },
): DomainError {
  return new DomainError("NOT_FOUND", message, init);
}

export function revisionConflict(expected: number, current: number): DomainError {
  return new DomainError(
    "REVISION_CONFLICT",
    `Expected revision ${expected} but the current revision is ${current}`,
    {
      path: "expectedRevision",
      hint: `The current revision is ${current}. Call \`get_presentation\` and reapply the change with expected_revision ${current}.`,
      retryable: true,
      details: { currentRevision: current, expectedRevision: expected },
    },
  );
}

export function limitExceeded(
  what: string,
  limit: number,
  received: number,
  init: { path?: string; hint?: string; unit?: string } = {},
): DomainError {
  const unit = init.unit === undefined ? "" : ` ${init.unit}`;
  return new DomainError(
    "LIMIT_EXCEEDED",
    `${what}: the limit is ${limit}${unit} and the request needs ${received}${unit}`,
    {
      path: init.path,
      hint: init.hint ?? `Stay within the limit of ${limit}${unit}.`,
      details: { limit, received },
    },
  );
}

export function forbiddenScope(scope: string): DomainError {
  return new DomainError("FORBIDDEN_SCOPE", `This action requires the \`${scope}\` scope`, {
    hint: `Ask the owner for a token with \`${scope}\`, or to do this from the panel.`,
    details: { requiredScope: scope },
  });
}

export function forbiddenActor(action: string): DomainError {
  return new DomainError("FORBIDDEN_ACTOR", `Only the owner can ${action}`, {
    hint: "This action is reserved for a human with a panel session. Ask the owner to do it from the panel.",
  });
}

export function internalError(cause: unknown, requestId?: string): DomainError {
  return new DomainError("INTERNAL", "Internal error", {
    hint:
      requestId === undefined
        ? "This is a server error. Retry once; if it persists, report it to the owner."
        : `This is a server error. Retry once; if it persists, report request id ${requestId} to the owner.`,
    retryable: true,
    cause,
    ...(requestId === undefined ? {} : { details: { requestId } }),
  });
}

/** Shortens untrusted text before echoing it in a message. */
export function clip(text: string, max = 60): string {
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e]/g, "?");
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
