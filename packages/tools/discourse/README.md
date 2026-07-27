# Alef Discourse adapter

This adapter maps Alef commands and a direct `context.stage` contribution onto the Discourse application service.

`src/domain/` is the Board/Forum/Topic/Thread/Post capability itself -- types, `DiscourseStore` port, `DiscourseService`, and an in-memory reference implementation. It has no Alef-specific import (no kernel, no adapter framework) and is the boundary that would move first if Discourse ever gets a second real consumer beyond this adapter. Everything else in `src/` is Alef-specific wiring: the adapter, SQLite/Papyrus/Scribe store backends, and command handlers.

| Alef surface | Capability operation |
|---|---|
| `discourse.post` | `post` with the tool-call ID as idempotency key and the bus correlation ID |
| `discourse.read` | bounded `readThread` |
| `discourse.list` | bounded `listTopics` or `listThreads` |
| `context.stage` | sequenced push subscription plus bounded open-question query |
| board-scoped SQLite | `DiscourseStore` with atomic post, events, cursors, outbox, lifecycle, and participation |
| Scribe integration | idempotent `DiscourseProjection` with durable checkpoint and observable lag |

The adapter accepts only a capability-backed mutation authority. It does not fall back to the legacy direct store after transport or projection failure. Existing legacy tables remain readable by migration support, but new writes use the capability tables. Shared memory and SQLite conformance fixtures prove identical post, reply, query, event, cursor, replay, snapshot, concurrency, and projection behavior.

## Papyrus Context Mesh store

`PapyrusDiscourseStore` maps the same `DiscourseStore` port onto Papyrus's authenticated `discourse.store` daemon operation. Every call carries an explicit store namespace; reads, event replay, per-board consumer cursors, and projection outbox access retain the capability's bounds. `PapyrusArtifactReferenceVerifier` verifies artifact kind and identity through the read-only `artifact.show` operation before the application accepts a referenced artifact.

The adapter never calls generic `artifact.create`, `docs.create`, or `graph.link` for forum mutations. Papyrus atomically commits domain extension rows and graph projections, and rejects direct writes to `context-thread`, `context-message`, `reply_to`, and `discusses` outside the Discourse-owned operation.
