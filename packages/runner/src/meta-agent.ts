import type { Api, Model } from "@dpopsuev/alef-ai";
import { createAlefApiOrgan, type DirectiveAdapter } from "@dpopsuev/alef-organ-alef";
import { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import { createAgentLoop } from "@dpopsuev/alef-organ-llm";
import { Agent } from "@dpopsuev/alef-runtime";
import { DEFAULT_MODEL } from "./args.js";
import { buildModel } from "./model.js";
import type { DirectiveView } from "./session.js";
import { InProcessStrategy, type SubagentFactory } from "./strategies/in-process.js";

function makeMetaFactory(
	model: Model<Api>,
	baseSystemPrompt: string,
	baseOnChunk?: (chunk: string) => void,
): SubagentFactory {
	return ({ organs, onChunk, systemPrompt: callSystemPrompt }) => {
		const agent = new Agent();
		let reply = "";
		const dialog = new DialogOrgan({
			sink: (t) => {
				if (t) reply = t;
			},
		});
		const mergedPrompt = [baseSystemPrompt, callSystemPrompt].filter(Boolean).join("\n\n") || baseSystemPrompt;
		const chunkHandler = onChunk ?? baseOnChunk;
		const llm = createAgentLoop({
			model,
			timeoutMs: 60_000,
			getTools: () => agent.tools,
			systemPrompt: mergedPrompt,
			onEvent: chunkHandler
				? (e) => {
						if (e.type === "chunk") chunkHandler(e.text);
					}
				: undefined,
		});
		for (const organ of organs) agent.load(organ);
		agent.load(dialog).load(llm);
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

const META_SYSTEM_PROMPT =
	"You are the :meta command inside Alef, a coding agent. " +
	"You answer questions about the running Alef instance: past sessions, system prompt directives, and loaded organs. " +
	"When asked what you are or what you can do, explain that concisely. " +
	"When asked about sessions: use alef.sessions.list then alef.sessions.read. " +
	"When asked about the system prompt: use alef.directive.list. " +
	"When asked to change a directive: use alef.directive.enable, disable, toggle, or replace. " +
	"If a question is genuinely unrelated to Alef, say what you can help with instead and stop. " +
	"No markdown headings. No preamble. No unnecessary caveats.";

export async function runMetaAgent(
	prompt: string,
	modelId?: string,
	onChunk?: (chunk: string) => void,
	getDirective?: () => DirectiveView | undefined,
): Promise<string> {
	const model = modelId ? buildModel(modelId) : buildModel(DEFAULT_MODEL);
	// DirectiveView is structurally a subset of DirectiveAdapter; the runtime object
	// from getDirectiveAdapter() satisfies the full interface.
	const organs = [
		createAlefApiOrgan({ getDirective: getDirective as (() => DirectiveAdapter | undefined) | undefined }),
	];
	const strategy = new InProcessStrategy(organs, makeMetaFactory(model, META_SYSTEM_PROMPT, onChunk));
	return strategy.send({ text: prompt, sender: "human", timeoutMs: 60_000 });
}
