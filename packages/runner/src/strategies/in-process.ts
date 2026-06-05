import type { Api, Model } from "@dpopsuev/alef-ai";
import type { ExecutionStrategy, Organ } from "@dpopsuev/alef-kernel";
import { debugLog } from "@dpopsuev/alef-kernel";
import { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import { Cerebrum } from "@dpopsuev/alef-organ-llm";
import { Agent } from "@dpopsuev/alef-runtime";

export class InProcessStrategy implements ExecutionStrategy {
	constructor(
		private readonly organs: Organ[],
		private readonly model: Model<Api>,
		private readonly systemPrompt?: string,
		private readonly onChunk?: (chunk: string) => void,
	) {}

	async send(text: string, _sender?: string, timeoutMs = 60_000, onChunk?: (chunk: string) => void): Promise<string> {
		const agent = new Agent();
		let reply = "";

		const dialog = new DialogOrgan({
			sink: (t) => {
				if (t) reply = t;
			},
		});

		const chunkHandler = onChunk ?? this.onChunk;
		const llm = new Cerebrum({
			model: this.model,
			timeoutMs,
			getTools: () => agent.tools,
			systemPrompt: this.systemPrompt,
			trackConcurrentOps: true,
			onEvent: chunkHandler
				? (e) => {
						if (e.type === "chunk") chunkHandler(e.text);
						else if (e.type === "tool-chunk") chunkHandler(e.text);
					}
				: undefined,
		});

		for (const organ of this.organs) agent.load(organ);
		agent.load(dialog).load(llm);

		debugLog("in-process:start", { organs: this.organs.map((o) => o.name), timeoutMs });
		await agent.ready();
		try {
			await dialog.send(text, "human", timeoutMs);
		} catch (error) {
			debugLog("in-process:error", { err: error instanceof Error ? error : new Error(String(error)) });
			throw error;
		} finally {
			agent.dispose();
		}
		debugLog("in-process:done", { replyLength: reply.length });
		return reply;
	}
}
