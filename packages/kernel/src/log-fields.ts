/**
 * Standard log field keys — unified schema across all Alef packages.
 *
 * Use these constants instead of raw strings. Typos become compile errors.
 * If the same concept has two spellings across packages, the schema is broken.
 *
 * Naming: snake_case for log fields (pino/OTel convention).
 * Values match the field names in StorageRecord, BusMessage, and Post.
 */
export const LogField = {
	component: "component",
	organ: "organ",
	tool: "tool",
	correlationId: "correlationId",
	sessionId: "sessionId",
	turn: "turn",
	elapsed: "elapsedMs",
	error: "err",
	event: "event",
	path: "path",
	bus: "bus",
	author: "author",
	timestamp: "timestamp",
	workflowId: "workflowId",
	taskId: "taskId",
	profile: "profile",
	status: "status",
} as const;
