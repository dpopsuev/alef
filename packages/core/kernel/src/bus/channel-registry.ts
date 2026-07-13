import type { ChannelName } from "./messages.js";

/**
 * Canonical channel assignments for well-known event types.
 * Publishing an event on a different channel is a bug — the consumer
 * won't see it (e.g. connectObservers only listens to notification).
 */
const CHANNEL_REGISTRY: ReadonlyMap<string, ChannelName> = new Map<string, ChannelName>([
	["llm.chunk", "notification"],
	["llm.thinking", "notification"],
	["llm.tool-start", "notification"],
	["llm.tool-end", "notification"],
	["llm.tool-chunk", "notification"],
	["llm.tool-stall", "notification"],
	["llm.tool-validation-error", "notification"],
	["llm.token-usage", "notification"],
	["llm.result", "notification"],
	["llm.turn-error", "notification"],
	["llm.message-queued", "notification"],
	["context.compact.request", "notification"],
	["context.compacted", "notification"],
	["context.overflow-recovery", "notification"],
	["session.metadata.refresh", "notification"],
	["plan.opened", "notification"],
	["agent.run.inner", "notification"],
	["workflow.step", "notification"],
	["workflow.completed", "notification"],
	["workflow.error", "notification"],
	["workflow.escalated", "notification"],
	["task.progress", "notification"],
	["task.completed", "notification"],
	["task.failed", "notification"],
	["llm.response", "command"],
	["llm.input", "event"],
	["context.assemble", "command"],
]);

/** Check if a publish targets the correct channel. Returns null if correct or unregistered, or the expected channel if wrong. */
export function checkChannelViolation(type: string, actualChannel: ChannelName): ChannelName | null {
	const expected = CHANNEL_REGISTRY.get(type);
	if (!expected) return null;
	return expected !== actualChannel ? expected : null;
}

/** Get the canonical channel for an event type, or undefined if not registered. */
export function canonicalChannel(type: string): ChannelName | undefined {
	return CHANNEL_REGISTRY.get(type);
}
