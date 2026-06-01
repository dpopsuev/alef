import type { PromptAdapter } from "@dpopsuev/alef-organ-alef";
import { createAlefApiOrgan } from "@dpopsuev/alef-organ-alef";
import { DEFAULT_MODEL } from "./args.js";
import { buildModel } from "./model.js";
import { InProcessStrategy } from "./strategies/in-process.js";

const META_SYSTEM_PROMPT =
	"You are the Alef meta-agent. You have typed tools to query Alef session history, config, and organs. " +
	"Use alef.sessions.list to discover all sessions. Use alef.sessions.search to find sessions by topic. " +
	"Use alef.sessions.read to get the content of a specific session. " +
	"Use alef.prompt.list to show the system prompt blocks. Use alef.prompt.enable/disable/toggle/replace to modify them. " +
	"Respond concisely. Do not write files. Do not use markdown headings.";

export async function runMetaAgent(
	prompt: string,
	modelId?: string,
	onChunk?: (chunk: string) => void,
	getPrompt?: () => PromptAdapter | undefined,
): Promise<string> {
	const model = modelId ? buildModel(modelId) : buildModel(DEFAULT_MODEL);
	const strategy = new InProcessStrategy([createAlefApiOrgan({ getPrompt })], model, META_SYSTEM_PROMPT);
	const reply = await strategy.send(prompt, "human", 60_000);
	onChunk?.(reply);
	return reply;
}
