export interface SendRequest {
	text: string;
	sender?: string;
	timeoutMs?: number;
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
