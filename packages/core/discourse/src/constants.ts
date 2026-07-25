/** Protocol version accepted by the application service. */
export const DISCOURSE_COMMAND_VERSION = "discourse.command.v1" as const;
/** Protocol version emitted by subscriptions. */
export const DISCOURSE_EVENT_VERSION = "discourse.event.v1" as const;
/** Maximum identifier length at every command boundary. */
export const IDENTIFIER_MAX_LENGTH = 128;
/** Maximum serialized post body size. */
export const POST_CONTENT_MAX_BYTES = 65_536;
/** Maximum verified artifact references per post. */
export const POST_REFERENCE_MAX_COUNT = 32;
/** Default bounded query size. */
export const QUERY_DEFAULT_LIMIT = 50;
/** Hard query size ceiling. */
export const QUERY_MAX_LIMIT = 100;
/** Hard subscription replay size ceiling. */
export const SUBSCRIPTION_MAX_BATCH = 64;
/** Hard projection delivery size ceiling. */
export const PROJECTION_MAX_BATCH = 64;
/** Bounded attempts per projection record. */
export const PROJECTION_MAX_ATTEMPTS = 3;
/** Default retained in-memory event count. */
export const EVENT_RETENTION_DEFAULT = 1_024;
/** Default in-memory post count ceiling. */
export const POST_CAPACITY_DEFAULT = 10_000;
