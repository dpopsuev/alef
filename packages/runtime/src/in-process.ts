import type { SubagentFactory, SubagentFactoryOptions } from "@dpopsuev/alef-agent-blueprint";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { Watchdog } from "@dpopsuev/alef-kernel/bus";
import {
	DEFAULT_CONVERSATION_TIMEOUT_MS,
	DEFAULT_STALL_TIMEOUT_MS,
	type ExecutionStrategy,
	type SendRequest,
} from "@dpopsuev/alef-kernel/execution";
import { traceEvent } from "@dpopsuev/alef-kernel/log";

export type { SubagentFactory, SubagentFactoryOptions };

export class InProcessStrategy implements ExecutionStrategy {
	constructor(
		private readonly organs: Adapter[],
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
			traceEvent("in-process:stall", { stallMs });
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
		traceEvent("in-process:start", { organs: this.organs.map((o) => o.name), conversationTimeoutMs, stallMs });

		const onAbort = () => {
			watchdog.stop();
			session.dispose();
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		watchdog.start();

		try {
			const reply = await session.send(text, "human", conversationTimeoutMs);
			traceEvent("in-process:done", { replyLength: reply.length });
			return reply;
		} catch (error) {
			if (signal?.aborted) throw new Error("Aborted");
			traceEvent("in-process:error", { err: error instanceof Error ? error : new Error(String(error)) });
			throw error;
		} finally {
			watchdog.stop();
			signal?.removeEventListener("abort", onAbort);
			session.dispose();
		}
	}
}
