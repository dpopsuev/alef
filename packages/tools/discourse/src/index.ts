export {
	createDiscourseAdapter,
	createDiscourseAdapter as createAdapter,
	type DiscourseAdapterOptions,
} from "./adapter.js";
export type { DiscourseBackend } from "./backend.js";
export {
	CapabilityDiscourseBackend,
	CapabilityDiscourseBackend as InMemoryDiscourseStore,
} from "./capability-backend.js";
export { ensureDiscourseSchema } from "./ensure-schema.js";
export { createHttpScribeArtifactCall, scribeCallFromEnv } from "./http-scribe-call.js";
export {
	type OpenDiscourseBackendOptions,
	openDiscourseBackend,
	openInMemoryDiscourseBackend,
} from "./open-backend.js";
export { type ScribeArtifactCall, ScribeDiscourseProjection } from "./scribe-projection.js";
export { service } from "./service.js";
export { SqliteCapabilityDiscourseStore } from "./sqlite-capability-store.js";
export type { Post, ThreadInfo, TopicSummary } from "./types.js";
