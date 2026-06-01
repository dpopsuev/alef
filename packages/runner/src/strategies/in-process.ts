import type { Api, Model } from "@dpopsuev/alef-ai";
import { Agent } from "@dpopsuev/alef-corpus";
import { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import { Cerebrum } from "@dpopsuev/alef-organ-llm";
import type { DelegationStrategy, Organ } from "@dpopsuev/alef-spine";

export class InProcessStrategy implements DelegationStrategy {
	constructor(
		private readonly organs: Organ[],
		private readonly model: Model<Api>,
		private readonly systemPrompt?: string,
	) {}

	async send(text: string, _sender?: string, timeoutMs = 60_000): Promise<string> {
		const agent = new Agent();
		let reply = "";

		const dialog = new DialogOrgan({
			sink: (t) => {
				if (t) reply = t;
			},
			getTools: () => agent.tools,
			systemPrompt: this.systemPrompt,
		});

		const llm = new Cerebrum({ model: this.model, timeoutMs });

		for (const organ of this.organs) agent.load(organ);
		agent.load(dialog).load(llm);

		await agent.ready();
		await dialog.send(text, "human", timeoutMs);
		agent.dispose();
		return reply;
	}
}
