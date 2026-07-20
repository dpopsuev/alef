# Alef Discourse adapter

This adapter maps Alef command handlers and `context.assemble` onto the shared Discourse application service.

| Alef surface | Capability operation |
|---|---|
| `discourse.post` | `post` with the tool-call ID as idempotency key and the bus correlation ID |
| `discourse.read` | bounded `readThread` |
| `discourse.list` | bounded `listTopics` or `listThreads` |
| `context.assemble` | sequenced push subscription plus bounded open-question query |
| session SQLite | `DiscourseStore` with atomic post, events, cursors, and outbox |
| Scribe integration | idempotent `DiscourseProjection` with durable checkpoint and observable lag |

The adapter accepts only a capability-backed mutation authority. It does not fall back to the legacy direct store after transport or projection failure. Existing legacy tables remain readable by migration support, but new writes use the capability tables. Shared memory and SQLite conformance fixtures prove identical post, reply, query, event, cursor, replay, snapshot, concurrency, and projection behavior.

## Papyrus Context Mesh store

`PapyrusDiscourseStore` maps the same `DiscourseStore` port onto Papyrus's authenticated `discourse.store` daemon operation. Every call carries an explicit store namespace; reads, event replay, per-session consumer cursors, and projection outbox access retain the capability's bounds. `PapyrusArtifactReferenceVerifier` verifies artifact kind and identity through the read-only `artifact.show` operation before the application accepts a referenced artifact.

The adapter never calls generic `artifact.create`, `docs.create`, or `graph.link` for forum mutations. Papyrus atomically commits domain extension rows and graph projections, and rejects direct writes to `context-thread`, `context-message`, `reply_to`, and `discusses` outside the Discourse-owned operation.
