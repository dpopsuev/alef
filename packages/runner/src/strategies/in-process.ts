import type { ExecutionStrategy, Organ, SendRequest } from "@dpopsuev/alef-kernel";
import { debugLog } from "@dpopsuev/alef-kernel";

export interface SubagentFactoryOptions {
	organs: readonly Organ[];
	onChunk?: (chunk: string) => void;
	systemPrompt?: string;
}

type SubagentSession = {
	send(text: string, sender: string, timeoutMs: number): Promise<string>;
	dispose(): void;
};

export type SubagentFactory = (opts: SubagentFactoryOptions) => SubagentSession;

export class InProcessStrategy implements ExecutionStrategy {
	constructor(
		private readonly organs: Organ[],
		private readonly createSession: SubagentFactory,
		private readonly baseSystemPrompt?: string,
		private readonly onChunk?: (chunk: string) => void,
	) {}

	async send({ text, timeoutMs: conversationTimeoutMs = 600_000, onChunk }: SendRequest): Promise<string> {
		const session = this.createSession({
			organs: this.organs,
			onChunk: onChunk ?? this.onChunk,
			systemPrompt: this.baseSystemPrompt,
		});
		debugLog("in-process:start", { organs: this.organs.map((o) => o.name), conversationTimeoutMs });
		try {
			const reply = await session.send(text, "human", conversationTimeoutMs);
			debugLog("in-process:done", { replyLength: reply.length });
			return reply;
		} catch (error) {
			debugLog("in-process:error", { err: error instanceof Error ? error : new Error(String(error)) });
			throw error;
		} finally {
			session.dispose();
		}
	}
}
