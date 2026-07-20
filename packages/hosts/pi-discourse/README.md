# Pi Discourse adapter

Native tools map Pi calls onto the host-neutral Discourse application service. The default standalone composition uses the shared bounded in-memory store; connected service composition can replace the driven ports without changing tool semantics.

Tools:

- `discourse_post` appends an idempotent post or reply.
- `discourse_read` returns one bounded thread page.
- `discourse_list` returns bounded topic or thread summaries.

Committed events are consumed through a sequenced subscription and injected at `before_agent_start`. Replay gaps produce an explicit resynchronization marker rather than silently skipping posts.
