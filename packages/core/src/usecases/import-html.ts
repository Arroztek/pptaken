// SPDX-License-Identifier: AGPL-3.0-or-later
// HTML-artifact import (ADR-022): a whole HTML document, as an agent writes it in a Claude artifact, becomes a new
// presentation. The pure importer (`@pptaken/sanitizer`) splits it into slides, theme CSS, library URLs and a deck
// script; then it is created exactly like `createPresentation` input: validated, vendored, sanitized, audited.
import {
  ArtifactImportError,
  importHtmlArtifact,
  type SplitHeuristic,
  type SplitMode,
} from "@pptaken/sanitizer";
import { type AspectRatio, canvasSize, LIMITS } from "@pptaken/schema";
import type { CoreWarning } from "../deck.js";
import { DomainError, internalError, isDomainError, validationError } from "../errors.js";
import { type CallContext, type Principal, requireScope } from "../principal.js";
import { requireObject } from "./context.js";
import { type CreatePresentationResult, createPresentation } from "./presentations.js";

export interface ImportHtmlInput {
  /** The complete HTML document (at most 2 MB). */
  html: string;
  /** Overrides the document's `<title>`. */
  title?: string;
  /** Overrides the document's `<html lang>`. */
  lang?: string;
  aspectRatio?: AspectRatio;
  /** Splitting heuristic (default `auto`). */
  split?: SplitMode;
  idempotencyKey?: string;
}

export interface ImportHtmlResult extends CreatePresentationResult {
  /** The heuristic that produced the slides. */
  heuristic: SplitHeuristic;
}

const SPLIT_MODES: readonly SplitMode[] = ["auto", "slides", "headings", "single"];
const LANG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** `decks:write`. Creates a presentation from an HTML document. */
export async function importHtmlDeck(
  ctx: Parameters<typeof createPresentation>[0],
  principal: Principal,
  rawInput: ImportHtmlInput,
  call?: CallContext,
): Promise<ImportHtmlResult> {
  requireScope(principal, "decks:write");
  const input = requireObject(rawInput) as unknown as ImportHtmlInput;
  if (typeof input.html !== "string" || input.html.trim() === "") {
    throw validationError("html must be the complete HTML document", {
      path: "html",
      hint: "Send the artifact's whole HTML (from <!doctype html> to </html>).",
    });
  }
  const split = input.split ?? "auto";
  if (!SPLIT_MODES.includes(split)) {
    throw validationError(`split must be one of ${SPLIT_MODES.join(", ")}`, { path: "split" });
  }
  const aspectRatio: AspectRatio = input.aspectRatio === "4:3" ? "4:3" : "16:9";
  let parts: ReturnType<typeof importHtmlArtifact>;
  try {
    parts = importHtmlArtifact(input.html, {
      split,
      canvas: canvasSize(aspectRatio),
      maxSlides: ctx.config.limits.maxSlides,
    });
  } catch (error) {
    if (
      error instanceof ArtifactImportError ||
      (error as { name?: unknown })?.name === "ArtifactImportError"
    ) {
      const e = error as ArtifactImportError;
      throw new DomainError(
        e.code === "TOO_LARGE" ? "LIMIT_EXCEEDED" : "VALIDATION_ERROR",
        e.message,
        { path: "html", hint: e.hint, details: { reason: e.code } },
      );
    }
    if (isDomainError(error)) throw error;
    throw internalError(error, call?.requestId);
  }
  const docTitle = (input.title ?? parts.title ?? "").trim();
  const title = (docTitle === "" ? "Imported presentation" : docTitle).slice(
    0,
    LIMITS.maxTitleLength,
  );
  const lang =
    input.lang ?? (parts.lang !== null && LANG.test(parts.lang) ? parts.lang : undefined);
  const extraWarnings: CoreWarning[] = parts.warnings.map((w) => ({
    code: w.code,
    message: w.message,
  }));
  const result = await createPresentation(
    ctx,
    principal,
    {
      title,
      ...(lang === undefined ? {} : { lang }),
      aspectRatio,
      ...(parts.themeCss.trim() === "" ? {} : { theme: { css: parts.themeCss } }),
      slides: parts.slides.map((s) => ({ title: s.title, html: s.html })),
      ...(parts.libs.length === 0 ? {} : { libs: parts.libs }),
      ...(parts.script === null ? {} : { script: parts.script }),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      summary: `Imported from HTML (${parts.heuristic}, ${parts.slides.length} slide(s))`,
      extraWarnings,
      auditAction: "presentation.import_html",
    },
    call,
  );
  return { ...result, heuristic: parts.heuristic };
}
