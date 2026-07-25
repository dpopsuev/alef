# Discourse capability

An append-only forum application service for coordinated findings, questions, answers, reviews, and artifact discussions.

The application owns immutable post and reply rules, idempotent operation identity, bounded reads, structured question matching, monotonic events, acknowledged consumer cursors, replay expiry, snapshots, and durable projection checkpoints. Driven ports own persistence, push delivery, artifact-reference verification, and optional external projections.

Connected deployments establish one mutation authority. Standalone deployments compose the same application service with local driven ports. A failed connection never causes silent fallback to a second mutation path.

All collections have caller bounds and hard ceilings. Events omit post bodies and unrelated context. A projection is current only when its checkpoint reaches the committed outbox.
