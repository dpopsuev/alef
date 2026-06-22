import type { Adapter } from "@dpopsuev/alef-kernel";
import { createMetaOrgan, type DirectiveAdapter } from "@dpopsuev/alef-meta";
import { InProcessStrategy } from "@dpopsuev/alef-runtime";
import { autoDetectModel, buildModel } from "./model/index.js";
import type { DirectiveView } from "./session.js";
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
	const model = modelId ? buildModel(modelId) : autoDetectModel();
	if (!model) throw new Error("No model available for :meta — set ALEF_MODEL or configure a provider API key");
	// DirectiveView is structurally a subset of DirectiveAdapter; the runtime object
	// from getDirectiveAdapter() satisfies the full interface.
	const organs: Adapter[] = [
		createMetaOrgan({
			dialogEventType: "llm.input",
			getDirective: getDirective as (() => DirectiveAdapter | undefined) | undefined,
		}),
	];
	const factory = buildSubagentFactory({ model: model, baseSystemPrompt: META_SYSTEM_PROMPT });
	const strategy = new InProcessStrategy(organs, (sessionOpts) =>
		factory({ ...sessionOpts, onChunk: sessionOpts.onChunk ?? onChunk }),
	);
	return strategy.send({ text: prompt, sender: "human", timeoutMs: 60_000 });
}
