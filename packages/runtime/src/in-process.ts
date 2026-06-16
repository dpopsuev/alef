import type { SubagentFactory, SubagentFactoryOptions } from "@dpopsuev/alef-agent-blueprint";
import {
	DEFAULT_CONVERSATION_TIMEOUT_MS,
	DEFAULT_STALL_TIMEOUT_MS,
	debugLog,
	type ExecutionStrategy,
	type Organ,
	type SendRequest,
	Watchdog,
} from "@dpopsuev/alef-kernel";

export type { SubagentFactory, SubagentFactoryOptions };

export class InProcessStrategy implements ExecutionStrategy {
	constructor(
		private readonly organs: Organ[],
		private readonly createSession: SubagentFactory,
		private readonly baseSystemPrompt?: string,
		private readonly onChunk?: (chunk: string) => void,
	) {}

	async send({
		text,
		timeoutMs: conversationTimeoutMs = DEFAULT_CONVERSATION_TIMEOUT_MS,
		stallMs = DEFAULT_STALL_TIMEOUT_MS,
		signal,
		onChunk,
		onInnerEvent,
	}: SendRequest): Promise<string> {
		if (signal?.aborted) throw new Error("Aborted before send");

		const watchdog = new Watchdog(stallMs, () => {
			debugLog("in-process:stall", { stallMs });
			session.dispose();
		});

		const wrappedChunk =
			(onChunk ?? this.onChunk)
				? (chunk: string) => {
						watchdog.reset();
						(onChunk ?? this.onChunk)?.(chunk);
					}
				: undefined;

		const wrappedInnerEvent = onInnerEvent
			? (callId: string, innerType: string, innerPayload: Record<string, unknown>) => {
					watchdog.reset();
					onInnerEvent(callId, innerType, innerPayload);
				}
			: undefined;

		const session = this.createSession({
			organs: this.organs,
			onChunk: wrappedChunk,
			onInnerEvent: wrappedInnerEvent,
			systemPrompt: this.baseSystemPrompt,
		});
		debugLog("in-process:start", { organs: this.organs.map((o) => o.name), conversationTimeoutMs, stallMs });

		const onAbort = () => {
			watchdog.stop();
			session.dispose();
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		watchdog.start();

		try {
			const reply = await session.send(text, "human", conversationTimeoutMs);
			debugLog("in-process:done", { replyLength: reply.length });
			return reply;
		} catch (error) {
			if (signal?.aborted) throw new Error("Aborted");
			debugLog("in-process:error", { err: error instanceof Error ? error : new Error(String(error)) });
			throw error;
		} finally {
			watchdog.stop();
			signal?.removeEventListener("abort", onAbort);
			session.dispose();
		}
	}
}
