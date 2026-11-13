# ADR-014 · Immutable revisions and soft delete

**Context.** The editor is an agent: it can misunderstand, overwrite or delete.

**Decision.**
- Every write creates an immutable **revision** (a full snapshot of the JSON envelope; assets are shared by hash). The last 50 per presentation are kept (configurable).
- Writes require `expected_revision` (optimistic concurrency control): if the deck changed, the agent receives `REVISION_CONFLICT` with the current revision.
- **Deleting = moving to trash** for 30 days. Permanent deletion is only done by a human in the panel.
- A **live session pins the revision** it started with: if the agent edits during the talk, the screen does not change until the presenter decides.

**Consequences.** (+) Cheap undo and confidence to delegate. (−) More storage (JSON text, bounded by the revision limit).
