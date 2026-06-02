import type { DirectiveAdapter } from "@dpopsuev/alef-organ-alef";
import { createAlefApiOrgan } from "@dpopsuev/alef-organ-alef";
import { DEFAULT_MODEL } from "./args.js";
import { buildModel } from "./model.js";
import { InProcessStrategy } from "./strategies/in-process.js";

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
	getDirective?: () => DirectiveAdapter | undefined,
): Promise<string> {
	const model = modelId ? buildModel(modelId) : buildModel(DEFAULT_MODEL);
	const strategy = new InProcessStrategy([createAlefApiOrgan({ getDirective })], model, META_SYSTEM_PROMPT, onChunk);
	return strategy.send(prompt, "human", 60_000);
}
