# @pptaken/mcp

The PPTaken MCP tools ([architecture §5](../../docs/foundation/02-architecture.md)) on top of `@pptaken/core`,
independent of the transport. License: AGPL-3.0-or-later. SDK: `@modelcontextprotocol/server` 2.4.0 (tests use
`@modelcontextprotocol/client` 2.4.0).

```ts
const server = createMcpServer({ core, principal, config: { version, baseUrl, rateLimit, onActivity }, call });
```

The HTTP layer (`apps/server`) builds one server per request (stateless) with the caller's `Principal`.

## Tools (in `tools/list` order)

`whoami`, `get_authoring_guide`, `create_presentation`, `list_presentations`, `get_presentation`,
`update_presentation`, `update_slides`, `delete_presentation`, `add_asset`, `get_presentation_links`.
`create_share_link` and `save_quiz_draft` belong to later phases. The JSON of `tools/list` is snapshotted in
`test/__snapshots__/tools-list.json`: any schema or description change shows up in review.

- **Inputs** are flat snake_case Zod schemas (`src/schemas.ts`) advertised as JSON Schema. The SDK's own argument
  validation is bypassed on purpose (a pass-through Standard Schema carrying the JSON Schema) so that invalid input
  becomes a structured `VALIDATION_ERROR` with `path` (`slides[2].html`) and `hint`, instead of the SDK's plain text.
  The core validates again.
- **Outputs** are compact JSON text (no `structuredContent` duplicate). The outline of the 20-slide example is
  about 1,000 tokens; full slides only on demand (`include: ["slides"]`, ideally with `slide_ids`).
- **Errors**: `isError: true` with the `DomainError.toJSON()` body `{ code, message, path?, hint, retryable, details? }`;
  core paths are converted to snake_case. Unexpected errors become `INTERNAL` with `details.request_id` and no cause.
- **Annotations**: read tools `readOnlyHint`; `create_presentation`, `update_presentation` write;
  `update_slides` and `delete_presentation` `destructiveHint: true`; `add_asset` `idempotentHint: true`
  (deduplicated by SHA-256); every tool `openWorldHint: false` except `import_html_deck` (it makes the server
  download the artifact's external resources).
- **Scopes** are checked by the core; `get_authoring_guide` needs `decks:read`; `whoami` needs none.
- **`add_asset`**: base64 (at most 1 MB decoded per call, checked before decoding) or `source.url` (an https URL the
  server downloads once through the SSRF-safe vendoring fetcher, ADR-022; `FETCH_BLOCKED`/`FETCH_FAILED` on refusal).
- **Vendoring (ADR-022)**: write tools return `vendored` (each external URL: kind, status, bytes, hash, error) when a
  write referenced external resources; `import_html_deck` imports a whole HTML artifact; `whoami.vendoring` and the
  guide's "External resources" section describe the instance's policy (`McpServerConfig.vendoring`).
- **Rate limits and activity** are callbacks (`config.rateLimit`, `config.onActivity`) so this package has no
  state; a limited call answers `RATE_LIMITED` with `details.retry_after_sec`.
- **`instructions`**: seven lines (use it only when the user asks for PPTaken, never by default; guide → create → give `urls.present` → edit with `expected_revision` → import an artifact).

## Authoring guide

`src/guide.ts`, about 5,900 characters (≈ 1,500 tokens; the test bound is 2,500 at 4 characters per token). Facts
come from `@pptaken/schema` (limits, fonts) and the sanitizer policy; the example slide is tested to sanitize with
no warnings. Bump `AUTHORING_GUIDE_VERSION` with the format or the policy.

## Open questions

- `get_presentation` `include: ["quiz"]` is not supported yet (the core has no quizzes).
- `urls.manage` points to `/decks/<id>`, the presentation's page in the panel; `interactive.approve_url` is the same
  page at `#scripts`, where the owner reads and approves the code (ADR-021).
