// SPDX-License-Identifier: AGPL-3.0-or-later
// The PPTaken MCP server: tools 1-10 of architecture §5.2 on top of @pptaken/core, independent of the transport.
// The HTTP layer builds one server per request (stateless) with the caller's Principal.
import {
  type CallToolResult,
  McpServer,
  type ServerContext,
  type StandardSchemaWithJSON,
  type ToolAnnotations,
} from "@modelcontextprotocol/server";
import {
  type CallContext,
  type Core,
  type CoreWarning,
  DomainError,
  type DomainErrorBody,
  isDomainError,
  type Principal,
  requireScope,
  type SlideUpsert,
} from "@pptaken/core";
import { LIMITS } from "@pptaken/schema";
import { type ZodType, z } from "zod";
import { AUTHORING_GUIDE, AUTHORING_GUIDE_VERSION, MAX_ASSET_BASE64_BYTES } from "./guide.js";
import {
  addAssetInput,
  createPresentationInput,
  deletePresentationInput,
  emptyInput,
  getPresentationInput,
  listPresentationsInput,
  presentationLinksInput,
  updatePresentationInput,
  updateSlidesInput,
} from "./schemas.js";

/** The `instructions` field of the server: the recommended flow in five lines (architecture §5.1). */
export const SERVER_INSTRUCTIONS = [
  "PPTaken turns slides you write into a presentation the user presents from a browser.",
  "1. Call get_authoring_guide once before writing slides: canvas size, allowed HTML/CSS, steps, fonts, limits.",
  "2. Call create_presentation with all the slides in one call.",
  "3. Give the returned urls.present to the user: it opens the presentation, ready to present.",
  "4. To edit, call get_presentation, then update_slides or update_presentation with expected_revision.",
].join("\n");

export interface RateLimitDecision {
  ok: boolean;
  retryAfterSec: number;
}

export interface McpServerConfig {
  /** Shown by `whoami` and in `serverInfo`. */
  version: string;
  /** Public base URL of the instance without a trailing slash, e.g. `https://slides.example.com`. */
  baseUrl: string;
  /** Rate limit per call (security §7: 120 calls/min, 20 writes/min per token). Optional. */
  rateLimit?: (input: { principal: Principal; tool: string; write: boolean }) => RateLimitDecision;
  /** Called at the start of every tool call (agent-connection status). Errors are ignored. */
  onActivity?: (input: {
    principal: Principal;
    tool: string;
    clientName: string | null;
  }) => void | Promise<void>;
}

export interface CreateMcpServerOptions {
  core: Core;
  principal: Principal;
  config: McpServerConfig;
  /** IP and request id, for the audit log and INTERNAL errors. */
  call?: CallContext;
}

// ---------------------------------------------------------------------------------------------------------------
// Results and errors

const iso = (ms: number | null | undefined) =>
  typeof ms === "number" ? new Date(ms).toISOString() : null;

function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function fail(body: DomainErrorBody): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(body) }], isError: true };
}

/** `presentationId` → `presentation_id`, keeping indexes: `slides[3].durationHintSec` → `slides[3].duration_hint_sec`. */
export function snakePath(path: string): string {
  return path.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function pathOf(parts: readonly PropertyKey[]): string {
  let out = "";
  for (const part of parts) {
    if (typeof part === "number") out += `[${part}]`;
    else out += out === "" ? String(part) : `.${String(part)}`;
  }
  return out;
}

function zodFailure(error: z.ZodError): DomainError {
  const issues = error.issues.slice(0, 10).map((issue) => {
    let path = pathOf(issue.path);
    let message = issue.message;
    if (issue.code === "unrecognized_keys") {
      const keys = issue.keys.slice(0, 5);
      path = path === "" ? (keys[0] ?? "") : `${path}.${keys[0] ?? ""}`;
      message = `Unknown field(s): ${keys.join(", ")}`;
    }
    return { path, message, code: issue.code };
  });
  const first = issues[0] ?? { path: "", message: "Invalid input", code: "custom" };
  let hint =
    "Fix the field named in `path` and call again. The tool's input schema lists every field (snake_case); call `get_authoring_guide` for the deck format.";
  if (first.code === "too_big" && /\.html$/.test(first.path)) {
    hint = `\`${first.path}\` exceeds ${LIMITS.maxSlideHtml / 1024} KB. Split the slide or move images to \`add_asset\`.`;
  } else if (first.code === "too_big" && first.path === "slides") {
    hint = `A presentation can have at most ${LIMITS.maxSlides} slides. Split it into several presentations.`;
  } else if (first.code === "unrecognized_keys") {
    hint =
      "Remove the unknown field. Field names are snake_case, e.g. `presentation_id`, `expected_revision`.";
  }
  const more = issues.length > 1 ? ` (and ${error.issues.length - 1} more issue(s))` : "";
  return new DomainError("VALIDATION_ERROR", `${first.path || "input"}: ${first.message}${more}`, {
    path: first.path || undefined,
    hint,
    details: { issues: issues.map(({ path, message }) => ({ path, message })) },
  });
}

function toBody(
  error: unknown,
  requestId: string | undefined,
  assetCall: boolean,
): DomainErrorBody {
  if (isDomainError(error)) {
    const body = error.toJSON();
    if (body.path !== undefined) {
      if (assetCall && body.path === "bytes") body.path = "source.base64";
      else if (assetCall && body.path === "mediaType") body.path = "source.media_type";
      else body.path = snakePath(body.path);
    }
    return body;
  }
  return new DomainError("INTERNAL", "Internal error", {
    hint:
      requestId === undefined
        ? "This is a server error. Retry once; if it persists, report it to the owner."
        : `This is a server error. Retry once; if it persists, report request id ${requestId} to the owner.`,
    retryable: true,
    ...(requestId === undefined ? {} : { details: { request_id: requestId } }),
  }).toJSON();
}

function warningsOf(warnings: readonly CoreWarning[]) {
  return warnings.map((w) => ({
    path: w.path ?? null,
    code: w.code,
    message: w.message,
    ...(w.slideId === undefined ? {} : { slide_id: w.slideId }),
  }));
}

/** Drops `undefined` properties (exactOptionalPropertyTypes). */
function defined<T extends Record<string, unknown>>(
  value: T,
): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as never;
}

/**
 * Advertises `schema` as JSON Schema in `tools/list` but lets every argument through the SDK's own validation, so
 * that the handler can answer invalid input with a structured, actionable VALIDATION_ERROR.
 */
function advertised(schema: ZodType): StandardSchemaWithJSON<unknown, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  return {
    "~standard": {
      version: 1,
      vendor: "pptaken",
      validate: (value: unknown) => ({ value }),
      jsonSchema: { input: () => json, output: () => json },
    },
  } as unknown as StandardSchemaWithJSON<unknown, unknown>;
}

const CLIENT_INFO_KEY = "io.modelcontextprotocol/clientInfo";

function clientNameOf(server: McpServer, ctx: ServerContext): string | null {
  const envelope = ctx.mcpReq?.envelope as Record<string, unknown> | undefined;
  const fromEnvelope = envelope?.[CLIENT_INFO_KEY] as
    | { name?: unknown; version?: unknown }
    | undefined;
  const info =
    fromEnvelope !== undefined && typeof fromEnvelope.name === "string"
      ? fromEnvelope
      : server.server.getClientVersion();
  if (info === undefined || typeof info.name !== "string") return null;
  const version = typeof info.version === "string" ? ` ${info.version}` : "";
  return `${info.name}${version}`.slice(0, 120);
}

// ---------------------------------------------------------------------------------------------------------------
// Tool definitions

const READ: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

interface ToolDef<S extends ZodType> {
  name: string;
  title: string;
  description: string;
  schema: S;
  annotations: ToolAnnotations;
  write: boolean;
  run: (args: z.infer<S>) => Promise<unknown>;
}

/** Creates a configured McpServer for one principal (one HTTP request in stateless mode). */
export function createMcpServer(options: CreateMcpServerOptions): McpServer {
  const { core, principal, config } = options;
  const call = options.call ?? {};
  const base = config.baseUrl.replace(/\/+$/, "");
  const urlsOf = (id: string) => ({
    present: `${base}/p/${encodeURIComponent(id)}`,
    manage: `${base}/decks/${encodeURIComponent(id)}`,
  });

  const server = new McpServer(
    { name: "pptaken", title: "PPTaken", version: config.version },
    { instructions: SERVER_INSTRUCTIONS, capabilities: { tools: { listChanged: false } } },
  );

  const register = <S extends ZodType>(def: ToolDef<S>) => {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: advertised(def.schema),
        annotations: { title: def.title, ...def.annotations },
      },
      async (args: unknown, ctx: ServerContext): Promise<CallToolResult> => {
        try {
          await config.onActivity?.({
            principal,
            tool: def.name,
            clientName: clientNameOf(server, ctx),
          });
        } catch {
          // Status tracking never fails a tool call.
        }
        const limit = config.rateLimit?.({ principal, tool: def.name, write: def.write });
        if (limit !== undefined && !limit.ok) {
          return fail(
            new DomainError("RATE_LIMITED", "Too many calls with this token", {
              hint: `Wait ${limit.retryAfterSec} s and retry. Batch edits: one update_slides call can change many slides.`,
              retryable: true,
              details: { retry_after_sec: limit.retryAfterSec },
            }).toJSON(),
          );
        }
        const parsed = def.schema.safeParse(args ?? {});
        if (!parsed.success) return fail(zodFailure(parsed.error).toJSON());
        try {
          return ok(await def.run(parsed.data));
        } catch (error) {
          return fail(toBody(error, call.requestId, def.name === "add_asset"));
        }
      },
    );
  };

  // 1. whoami
  register({
    name: "whoami",
    title: "Who am I",
    description:
      "Checks the connection: returns the PPTaken instance, its base URL, your token's scopes and the current limits. Call it to test the connection or when a scope error is unclear. It does not create or read presentations.",
    schema: emptyInput,
    annotations: READ,
    write: false,
    run: async () => {
      const l = core.config.limits;
      return {
        instance: "PPTaken",
        version: config.version,
        base_url: base,
        actor: principal.actor,
        scopes: [...principal.scopes],
        ...(principal.tokenId === undefined ? {} : { token_id: principal.tokenId }),
        authoring_guide_version: AUTHORING_GUIDE_VERSION,
        limits: {
          slides_per_presentation: l.maxSlides,
          slide_html_bytes: LIMITS.maxSlideHtml,
          slide_css_bytes: LIMITS.maxSlideCss,
          theme_css_bytes: LIMITS.maxThemeCss,
          notes_bytes: LIMITS.maxNotes,
          asset_bytes_per_call: Math.min(MAX_ASSET_BASE64_BYTES, l.maxAssetBytes),
          assets_per_presentation: l.maxAssetsPerDeck,
          asset_bytes_per_presentation: l.maxAssetBytesPerDeck,
        },
      };
    },
  });

  // 2. get_authoring_guide
  register({
    name: "get_authoring_guide",
    title: "Get the authoring guide",
    description:
      "Returns the deck authoring guide: canvas size, allowed HTML/CSS/SVG, reveal steps, fonts, images, limits and an example slide. Call it once before your first create_presentation or update_slides in a session. Do not call it repeatedly; it does not change during a session.",
    schema: emptyInput,
    annotations: READ,
    write: false,
    run: async () => {
      requireScope(principal, "decks:read");
      return { version: AUTHORING_GUIDE_VERSION, guide: AUTHORING_GUIDE };
    },
  });

  // 3. create_presentation
  register({
    name: "create_presentation",
    title: "Create a presentation",
    description:
      "Creates a complete presentation in one call (all slides) and returns presentation_id, revision 1 and urls; give urls.present to the user. Call get_authoring_guide first. Use idempotency_key so a retry does not create a duplicate. To change an existing presentation use update_slides or update_presentation instead. Images: create first, then add_asset and update_slides.",
    schema: createPresentationInput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    write: true,
    run: async (a) => {
      const result = await core.createPresentation(
        principal,
        defined({
          title: a.title,
          lang: a.lang,
          aspectRatio: a.aspect_ratio,
          theme:
            a.theme === undefined ? undefined : defined({ css: a.theme.css, fonts: a.theme.fonts }),
          targetMinutes: a.target_minutes,
          idempotencyKey: a.idempotency_key,
          slides: a.slides.map((s) =>
            defined({
              id: s.id,
              title: s.title,
              html: s.html,
              css: s.css,
              notes: s.notes,
              section: s.section,
              durationHintSec: s.duration_hint_sec,
            }),
          ),
        }),
        call,
      );
      return {
        presentation_id: result.presentationId,
        revision: result.revision,
        slide_count: result.slideCount,
        urls: urlsOf(result.presentationId),
        warnings: warningsOf(result.warnings),
        ...(result.replayed ? { replayed: true } : {}),
      };
    },
  });

  // 4. list_presentations
  register({
    name: "list_presentations",
    title: "List presentations",
    description:
      "Lists presentations, newest first, with optional title search and pagination (next_cursor). Use it to find a presentation_id. It returns no slide content: call get_presentation for that. Presentations in the trash are not listed.",
    schema: listPresentationsInput,
    annotations: READ,
    write: false,
    run: async (a) => {
      const page = await core.listPresentations(
        principal,
        defined({ query: a.query, cursor: a.cursor, limit: a.limit }),
        call,
      );
      return {
        presentations: page.items.map((d) => ({
          presentation_id: d.presentationId,
          title: d.title,
          lang: d.lang,
          revision: d.revision,
          slide_count: d.slideCount,
          updated_at: iso(d.updatedAt),
        })),
        next_cursor: page.nextCursor,
      };
    },
  });

  // 5. get_presentation
  register({
    name: "get_presentation",
    title: "Get a presentation",
    description:
      'Reads a presentation. By default returns the outline (slide ids, titles, sections, step counts) and the current revision, which you need as expected_revision for edits. Ask for "slides" (html/css) only for the slides you will edit, using slide_ids, to keep the response small; "notes" returns speaker notes; "theme" the theme.',
    schema: getPresentationInput,
    annotations: READ,
    write: false,
    run: async (a) => {
      const view = await core.getPresentation(
        principal,
        defined({ presentationId: a.presentation_id, include: a.include, slideIds: a.slide_ids }),
        call,
      );
      return defined({
        presentation_id: view.presentationId,
        title: view.title,
        lang: view.lang,
        aspect_ratio: view.aspectRatio,
        revision: view.revision,
        slide_count: view.slideCount,
        target_minutes: view.targetMinutes,
        updated_at: iso(view.updatedAt),
        outline: view.outline?.map((o) =>
          defined({
            id: o.id,
            title: o.title,
            section: o.section,
            steps: o.steps,
            has_notes: o.hasNotes,
          }),
        ),
        theme: view.theme,
        slides: view.slides?.map((s) =>
          defined({
            id: s.id,
            title: s.title,
            html: s.html,
            css: s.css,
            section: s.section,
            duration_hint_sec: s.durationHintSec,
          }),
        ),
        notes: view.notes,
      });
    },
  });

  // 6. update_presentation
  register({
    name: "update_presentation",
    title: "Update presentation metadata",
    description:
      "Changes the title, language, aspect ratio, theme (replaced as a whole) or target minutes, or reorders slides (slide_order must list every current id once). Requires expected_revision from get_presentation. To edit slide content use update_slides instead.",
    schema: updatePresentationInput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    write: true,
    run: async (a) => {
      const theme =
        a.theme === undefined || a.theme === null
          ? a.theme
          : defined({ css: a.theme.css, fonts: a.theme.fonts });
      const r = await core.updatePresentation(
        principal,
        defined({
          presentationId: a.presentation_id,
          expectedRevision: a.expected_revision,
          title: a.title,
          lang: a.lang,
          aspectRatio: a.aspect_ratio,
          theme,
          targetMinutes: a.target_minutes,
          slideOrder: a.slide_order,
        }),
        call,
      );
      return {
        presentation_id: r.presentationId,
        revision: r.revision,
        slide_count: r.slideCount,
        warnings: warningsOf(r.warnings),
      };
    },
  });

  // 7. update_slides
  register({
    name: "update_slides",
    title: "Insert, edit or remove slides",
    description:
      'Edits slides by id in one call: each upsert with an existing id changes only the fields sent (null clears css, notes, section or duration_hint_sec); a new or missing id inserts a slide after `after` ("start", "end" or a slide id; default end); then `remove` deletes ids. Requires expected_revision from get_presentation. Old revisions are kept, so removals can be undone by the owner.',
    schema: updateSlidesInput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    write: true,
    run: async (a) => {
      const upsert: SlideUpsert[] | undefined = a.upsert?.map(
        (u) =>
          defined({
            id: u.id,
            after: u.after,
            title: u.title,
            html: u.html,
            css: u.css,
            notes: u.notes,
            section: u.section,
            durationHintSec: u.duration_hint_sec,
          }) as SlideUpsert,
      );
      const r = await core.updateSlides(
        principal,
        defined({
          presentationId: a.presentation_id,
          expectedRevision: a.expected_revision,
          upsert,
          remove: a.remove,
        }),
        call,
      );
      return {
        presentation_id: r.presentationId,
        revision: r.revision,
        slide_count: r.slideCount,
        warnings: warningsOf(r.warnings),
      };
    },
  });

  // 8. delete_presentation
  register({
    name: "delete_presentation",
    title: "Move a presentation to the trash",
    description:
      "Moves a presentation to the trash. The owner can restore it from the panel for 30 days; there is no permanent deletion from here. Only call it when the user explicitly asked to delete this presentation.",
    schema: deletePresentationInput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    write: true,
    run: async (a) => {
      const r = await core.trashPresentation(
        principal,
        { presentationId: a.presentation_id },
        call,
      );
      return {
        presentation_id: r.presentationId,
        trashed: true,
        restorable_until: iso(r.restorableUntil),
      };
    },
  });

  // 9. add_asset
  register({
    name: "add_asset",
    title: "Upload an image",
    description:
      "Uploads an image (PNG, JPEG, WebP, AVIF or GIF, at most 1 MB decoded) for a presentation as source { base64, media_type } and returns its ref (asset:<sha256>) to use in <img src> or background-image:url(); then save the slide with update_slides. Uploading the same bytes twice returns the same ref. SVG: write it inline in the slide instead.",
    schema: addAssetInput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    write: true,
    run: async (a) => {
      const source = a.source;
      if (source.url !== undefined) {
        throw new DomainError(
          "FETCH_BLOCKED",
          "Downloading images from a URL is not available yet",
          {
            path: "source.url",
            hint: "Upload the image as base64 instead: source { base64, media_type }, at most 1 MB decoded.",
          },
        );
      }
      if (source.base64 === undefined) {
        throw new DomainError("VALIDATION_ERROR", "source.base64 is required", {
          path: "source.base64",
          hint: "Send the file content as source { base64, media_type }.",
        });
      }
      if (source.media_type === undefined) {
        throw new DomainError("VALIDATION_ERROR", "source.media_type is required", {
          path: "source.media_type",
          hint: "Send the media type, e.g. image/png or image/webp.",
        });
      }
      const b64 = source.base64.replace(/\s+/g, "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) {
        throw new DomainError("VALIDATION_ERROR", "source.base64 is not valid base64", {
          path: "source.base64",
          hint: "Encode the file with standard base64 (A-Z a-z 0-9 + /, padded with =).",
        });
      }
      const decoded = (b64.length / 4) * 3 - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
      if (decoded > MAX_ASSET_BASE64_BYTES) {
        throw new DomainError(
          "LIMIT_EXCEEDED",
          `Image too large: the limit is ${MAX_ASSET_BASE64_BYTES} bytes per call and the image has ${decoded} bytes`,
          {
            path: "source.base64",
            hint: "Resize or compress the image (WebP or AVIF are much smaller) to at most 1 MB.",
            details: { limit: MAX_ASSET_BASE64_BYTES, received: decoded },
          },
        );
      }
      const bytes = new Uint8Array(Buffer.from(b64, "base64"));
      const r = await core.addAsset(
        principal,
        defined({
          presentationId: a.presentation_id,
          bytes,
          mediaType: source.media_type,
          filename: a.filename,
        }),
        call,
      );
      return {
        ref: r.ref,
        media_type: r.mediaType,
        width: r.width,
        height: r.height,
        bytes: r.bytes,
        ...(r.deduplicated ? { deduplicated: true } : {}),
      };
    },
  });

  // 10. get_presentation_links
  register({
    name: "get_presentation_links",
    title: "Get presentation links",
    description:
      "Returns the URLs of a presentation: urls.present (opens the player; give it to the user) and urls.manage (the owner's panel), plus its public links (none in this version). It does not create links.",
    schema: presentationLinksInput,
    annotations: READ,
    write: false,
    run: async (a) => {
      const view = await core.getPresentation(
        principal,
        { presentationId: a.presentation_id, include: [] },
        call,
      );
      return {
        presentation_id: view.presentationId,
        title: view.title,
        revision: view.revision,
        urls: urlsOf(view.presentationId),
        share_links: [],
      };
    },
  });

  return server;
}

/** Names of the tools in `tools/list` order. */
export const TOOL_NAMES = [
  "whoami",
  "get_authoring_guide",
  "create_presentation",
  "list_presentations",
  "get_presentation",
  "update_presentation",
  "update_slides",
  "delete_presentation",
  "add_asset",
  "get_presentation_links",
] as const;

/** Tools that write (rate-limited separately). */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  "create_presentation",
  "update_presentation",
  "update_slides",
  "delete_presentation",
  "add_asset",
]);
