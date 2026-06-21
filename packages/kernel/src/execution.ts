// Increased from 600s (10min) to match Claude Sonnet 4-5 thinking mode requirements
// Thinking mode can take 50-60s for complex analysis, previous 60s default was too tight
export const DEFAULT_CONVERSATION_TIMEOUT_MS = Number(process.env.ALEF_CONVERSATION_TIMEOUT_MS) || 900_000; // 15 minutes
// Increased stall timeout to accommodate thinking mode periods without chunks
export const DEFAULT_STALL_TIMEOUT_MS = Number(process.env.ALEF_STALL_TIMEOUT_MS) || 180_000; // 3 minutes

/**
 * Default LLM timeout per turn in milliseconds.
 * Can be overridden via ALEF_LLM_TIMEOUT_MS environment variable.
 * Increased from 60s to 120s to accommodate Claude Sonnet 4-5 thinking mode (50-60s).
 */
export const DEFAULT_LLM_TIMEOUT_MS = Number(process.env.ALEF_LLM_TIMEOUT_MS) || 120_000;

export interface SendRequest {
	text: string;
	sender?: string;
	timeoutMs?: number;
	/** Idle timeout in ms. Strategy aborts if no activity (chunks, events) for this long. */
	stallMs?: number;
	/** Caller-owned signal. When aborted, the strategy cancels in-flight work and rejects. */
	signal?: AbortSignal;
	onChunk?: (chunk: string) => void;
	/**
	 * Called for each motor or signal event emitted by the inner agent.
	 * The outer DelegateOrgan publishes these as signal/agent.run.inner events,
	 * making inner agent activity visible in the outer session JSONL and TUI.
	 *
	 * @param callId  - toolCallId that identifies which agent.run call spawned this inner agent
	 * @param innerType - the motor/signal event type (e.g. "fs.read", "llm.chunk")
	 * @param innerPayload - the event payload
	 */
	onInnerEvent?: (callId: string, innerType: string, innerPayload: Record<string, unknown>) => void;
}

export interface ExecutionStrategy {
	send(req: SendRequest): Promise<string>;
	dispose?(): void;
}
