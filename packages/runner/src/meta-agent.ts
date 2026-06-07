import type { Api, Model } from "@dpopsuev/alef-ai";
import { createAlefApiOrgan, type DirectiveAdapter } from "@dpopsuev/alef-organ-alef";
import { DEFAULT_MODEL } from "./args.js";
import { buildModel } from "./model.js";
import type { DirectiveView } from "./session.js";
import { InProcessStrategy } from "./strategies/in-process.js";
import { buildSubagentFactory } from "./subagent-factory.js";

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
	const factory = buildSubagentFactory({ model: model as Model<Api>, baseSystemPrompt: META_SYSTEM_PROMPT });
	const strategy = new InProcessStrategy(organs, (sessionOpts) =>
		factory({ ...sessionOpts, onChunk: sessionOpts.onChunk ?? onChunk }),
	);
	return strategy.send({ text: prompt, sender: "human", timeoutMs: 60_000 });
}
