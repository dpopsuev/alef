function envInt(key: string, fallback: number): number {
	const raw = process.env[key];
	if (raw === undefined) return fallback;
	const n = Number(raw);
	return Number.isFinite(n) ? n : fallback;
}

export const DEFAULT_CONVERSATION_TIMEOUT_MS = envInt("ALEF_CONVERSATION_TIMEOUT_MS", 900_000);
export const DEFAULT_STALL_TIMEOUT_MS = envInt("ALEF_STALL_TIMEOUT_MS", 180_000);
export const DEFAULT_LLM_TIMEOUT_MS = envInt("ALEF_LLM_TIMEOUT_MS", 120_000);
export const DEFAULT_TOOL_TIMEOUT_MS = envInt("ALEF_TOOL_TIMEOUT_MS", 300_000);

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

export interface ExecutionStrategy {
	send(req: SendRequest): Promise<string>;
	dispose?(): void;
}
