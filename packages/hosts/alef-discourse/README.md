# Alef Discourse adapter

Native Alef commands map onto the host-neutral Discourse application service (`@danypops/discourse`), mirroring the `pi-discourse` host adapter's pattern one level down the stack: a thin composition of the shared bounded in-memory store, with zero Alef-specific persistence, projection, or backend-selection logic of its own.

Commands:

- `discourse.post` appends an idempotent post or reply.
- `discourse.read` returns one bounded thread page.
- `discourse.list` returns bounded topic or thread summaries.

Committed events are consumed through a sequenced subscription and injected via the `context.assemble` contribution. Replay gaps produce an explicit resynchronization marker rather than silently skipping posts.

This adapter's forum is process-local and in-memory, matching `pi-discourse`'s default composition exactly — it does not persist across restarts. For durable, cross-process multi-agent coordination, compose `@danypops/discourse`'s ports with a persistent `DiscourseStore` (for example `SqliteCapabilityDiscourseStore` from `@dpopsuev/alef-tool-discourse`) instead of the in-memory store used here.
