import type { Api, Model } from "@dpopsuev/alef-llm";
import { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import { createAgentLoop } from "@dpopsuev/alef-organ-llm";
import { Agent } from "@dpopsuev/alef-runtime";
import type { SubagentFactory } from "./strategies/in-process.js";

export interface SubagentSessionOptions {
	model: Model<Api>;
	baseSystemPrompt?: string;
	trackConcurrentOps?: boolean;
	forwardToolChunks?: boolean;
}

export function buildSubagentFactory(opts: SubagentSessionOptions): SubagentFactory {
	return ({ organs, onChunk, systemPrompt: callSystemPrompt }) => {
		const agent = new Agent();
		let reply = "";
		const dialog = new DialogOrgan({
			sink: (text) => {
				if (text) reply = text;
			},
		});
		const systemPrompt = [opts.baseSystemPrompt, callSystemPrompt].filter(Boolean).join("\n\n") || undefined;
		const chunkHandler = onChunk;
		const llm = createAgentLoop({
			model: opts.model,
			timeoutMs: 60_000,
			systemPrompt,
			trackConcurrentOps: opts.trackConcurrentOps,
		});
		for (const organ of organs) agent.load(organ);
		agent.load(dialog).load(llm);
		if (chunkHandler) {
			agent.observe({
				onMotorEvent(event) {
					const payload = (event as { payload?: Record<string, unknown> }).payload ?? {};
					if (event.type === "llm.chunk") chunkHandler(String(payload.text ?? ""));
					else if (opts.forwardToolChunks && event.type === "llm.tool-chunk")
						chunkHandler(String(payload.text ?? ""));
				},
				onSenseEvent() {},
			});
		}
		return {
			async send(text: string, sender: string, timeoutMs: number): Promise<string> {
				await agent.ready();
				await dialog.send(text, sender, timeoutMs);
				return reply;
			},
			dispose() {
				agent.dispose();
			},
		};
	};
}
