export * from "./access-policy.js";
export * from "./binding.js";
export * from "./budget.js";
// ── Hexagonal Architecture aliases (organ → adapter) ────────────────────
// Forward-compatible names. Use Adapter in new code; Organ remains for
// backward compat during the DDD rename campaign.
export type {
	Organ as Adapter,
	OrganContributions as AdapterContributions,
	OrganTheme as AdapterTheme,
} from "./buses.js";
export * from "./buses.js";
export { createContextAssemblyPipeline } from "./context-assembly-pipeline.js";
export { injectContextBlock } from "./context-helpers.js";
export { debugLog, initSessionSink, initSpineLogger } from "./debug.js";
export * from "./errors.js";
export * from "./execution.js";
export * from "./framework.js";
export { defineOrgan as defineAdapter } from "./framework.js";
export { InProcessNerve } from "./in-process-nerve.js";
export { LogField } from "./log-fields.js";
export * from "./mcp-organ.js";
export { type CacheStrategy, createMapCache, makeCacheKey } from "./organ-cache.js";
export type { DispatchOptions, EscalationHandler } from "./organ-dispatch.js";
export { explainOrgan, explainOrgan as explainAdapter } from "./organ-explain.js";
export type { BaseOrganOptions as BaseAdapterOptions, OrganTool as AdapterTool } from "./organ-sdk.js";
export * from "./organ-sdk.js";
export type { OrganLogger as AdapterLogger, OrganOptions as AdapterOptions } from "./organ-types.js";
export * from "./payload.js";
export * from "./protocols.js";
export * from "./truncate.js";
export * from "./watchdog.js";
