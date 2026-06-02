import type { DirectiveAdapter } from "@dpopsuev/alef-organ-alef";
import { createAlefApiOrgan } from "@dpopsuev/alef-organ-alef";
import { DEFAULT_MODEL } from "./args.js";
import { buildModel } from "./model.js";
import { InProcessStrategy } from "./strategies/in-process.js";

const META_SYSTEM_PROMPT =
	"You are the Alef meta-agent — a system utility, not a general assistant. " +
	"You have access to typed tools for the running Alef instance: sessions, directives, organs. " +
	"When asked about sessions, use alef.sessions.list or alef.sessions.search then alef.sessions.read. " +
	"When asked about the system prompt or directives, use alef.directive.list. " +
	"When asked to change a directive, use alef.directive.enable, disable, toggle, or replace. " +
	"If a question is not about Alef's sessions, config, or organs, say so in one sentence and stop. " +
	"Respond concisely. No markdown headings. No preamble.";

export async function runMetaAgent(
	prompt: string,
	modelId?: string,
	onChunk?: (chunk: string) => void,
	getDirective?: () => DirectiveAdapter | undefined,
): Promise<string> {
	const model = modelId ? buildModel(modelId) : buildModel(DEFAULT_MODEL);
	const strategy = new InProcessStrategy([createAlefApiOrgan({ getDirective })], model, META_SYSTEM_PROMPT, onChunk);
	return strategy.send(prompt, "human", 60_000);
}
