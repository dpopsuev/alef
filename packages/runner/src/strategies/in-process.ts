import type { Api, Model } from "@dpopsuev/alef-ai";
import { Agent } from "@dpopsuev/alef-corpus";
import { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import { Cerebrum } from "@dpopsuev/alef-organ-llm";
import type { ExecutionStrategy, Organ } from "@dpopsuev/alef-spine";

export class InProcessStrategy implements ExecutionStrategy {
	constructor(
		private readonly organs: Organ[],
		private readonly model: Model<Api>,
		private readonly systemPrompt?: string,
		private readonly onChunk?: (chunk: string) => void,
	) {}

	async send(text: string, _sender?: string, timeoutMs = 60_000): Promise<string> {
		const agent = new Agent();
		let reply = "";

		const dialog = new DialogOrgan({
			sink: (t) => {
				if (t) reply = t;
			},
		});

		const llm = new Cerebrum({
			model: this.model,
			timeoutMs,
			getTools: () => agent.tools,
			systemPrompt: this.systemPrompt,
			onEvent: this.onChunk
				? (e) => {
						if (e.type === "chunk" && this.onChunk) this.onChunk(e.text);
					}
				: undefined,
		});

		for (const organ of this.organs) agent.load(organ);
		agent.load(dialog).load(llm);

		await agent.ready();
		await dialog.send(text, "human", timeoutMs);
		agent.dispose();
		return reply;
	}
}
