/** Read an integer from an environment variable, returning the fallback if missing or non-numeric. */
function envInt(key: string, fallback: number): number {
	const raw = process.env[key];
	if (raw === undefined) return fallback;
	const n = Number(raw);
	return Number.isFinite(n) ? n : fallback;
}

/** Maximum wall-clock time for a full conversation (overridable via ALEF_CONVERSATION_TIMEOUT_MS). */
// eslint-disable-next-line no-magic-numbers
export const DEFAULT_CONVERSATION_TIMEOUT_MS = envInt("ALEF_CONVERSATION_TIMEOUT_MS", 900_000);
/** Idle timeout before the agent is considered stalled (overridable via ALEF_STALL_TIMEOUT_MS). */
// eslint-disable-next-line no-magic-numbers
export const DEFAULT_STALL_TIMEOUT_MS = envInt("ALEF_STALL_TIMEOUT_MS", 180_000);
/** Timeout for a single LLM HTTP call (overridable via ALEF_LLM_TIMEOUT_MS). */
// eslint-disable-next-line no-magic-numbers
export const DEFAULT_LLM_TIMEOUT_MS = envInt("ALEF_LLM_TIMEOUT_MS", 120_000);
/** Timeout for a single tool execution (overridable via ALEF_TOOL_TIMEOUT_MS). */
// eslint-disable-next-line no-magic-numbers
export const DEFAULT_TOOL_TIMEOUT_MS = envInt("ALEF_TOOL_TIMEOUT_MS", 300_000);

/** Ambient discussion coordinates for a workspace forum and the active topic within it. */
export interface DiscussionRef {
	forumId: string;
	topicId: string;
	topicTitle: string;
}

/** Lightweight thread watch record. Delivery semantics are defined separately from the base runtime model. */
export interface DiscussionSubscription {
	discussion: DiscussionRef;
	subscribedAt: number;
	mode?: "watch" | "participate" | "mentions-only";
	leaseExpiresAt?: number;
	unreadCount?: number;
	lastReadAt?: number;
	auto?: boolean;
}

/** Full discussion runtime state: canonical home thread, current active thread, and watched threads. */
export interface DiscussionState {
	home: DiscussionRef;
	active: DiscussionRef;
	subscriptions: DiscussionSubscription[];
}

/** Stable metadata that binds a delegated run to plans, discourse, and operator-visible task state. */
export interface RunDescriptor {
	taskId: string;
	profile: string;
	logicalAgentId?: string;
	actorAddress?: string;
	parentSessionId?: string;
	parentToolCallId?: string;
	sourceCallId?: string;
	correlationId?: string;
	planId?: string;
	stepId?: string;
	discourseTopic?: string;
	discourseThread?: string;
	modelId?: string;
	tokenBudget?: number;
	retryOfTaskId?: string;
	attempt?: number;
}

/** Snapshot of the current async task state. */
export interface TaskSnapshot {
	descriptor: RunDescriptor;
	status: "running" | "completed" | "failed" | "cancelled";
	startedAt: number;
	completedAt?: number;
	lastActivityAt: number;
	reply?: string;
	error?: string;
}

/** Parameters for sending a user message through an execution strategy. */
export interface SendRequest {
	text: string;
	sender?: string;
	run?: RunDescriptor;
	timeoutMs?: number;
	/** Idle timeout in ms. Strategy aborts if no activity (chunks, events) for this long. */
	stallMs?: number;
	/** Caller-owned signal. When aborted, the strategy cancels in-flight work and rejects. */
	signal?: AbortSignal;
	onChunk?: (chunk: string) => void;
	/**
	 * Called for each command or notification event emitted by the inner agent.
	 * The outer DelegateAdapter publishes these as notification/agent.run.inner events,
	 * making inner agent activity visible in the outer session JSONL and TUI.
	 *
	 * @param callId  - toolCallId that identifies which agent.run call spawned this inner agent
	 * @param innerType - the command/notification event type (e.g. "fs.read", "llm.chunk")
	 * @param innerPayload - the event payload
	 */
	onInnerEvent?: (callId: string, innerType: string, innerPayload: Record<string, unknown>) => void;
}

/** Pluggable strategy that drives the LLM conversation loop for a single send/reply cycle. */
export interface ExecutionStrategy {
	send(req: SendRequest): Promise<string>;
	dispose?(): void | Promise<void>;
}
