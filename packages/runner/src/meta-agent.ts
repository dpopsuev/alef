/**
 * Meta-agent — in-process Alef sub-agent with typed alef-api organ.
 *
 * Phase 2: uses alef-api organ (packages/organ-alef/) with typed tools
 * instead of the nodesh prelude from phase 1. ALE-TSK-385 / ALE-SPC-50.
 *
 * Phase 3 (TODO): stream reply through parent ChatWriter instead of
 * inline notice, and support alef.resume(id) for session hot-swap.
 */

import { Agent } from "@dpopsuev/alef-corpus";
import { createAlefApiOrgan } from "@dpopsuev/alef-organ-alef";
import { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import { Cerebrum } from "@dpopsuev/alef-organ-llm";
import { DEFAULT_MODEL } from "./args.js";
import { buildModel } from "./model.js";

const META_SYSTEM_PROMPT =
	"You are the Alef meta-agent. You have typed tools to query Alef session history, config, and organs. " +
	"Use alef.sessions.list to discover all sessions. Use alef.sessions.search to find sessions by topic. " +
	"Use alef.sessions.read to get the content of a specific session. " +
	"Respond concisely. Do not write files. Do not use markdown headings.";

export async function runMetaAgent(
	prompt: string,
	modelId?: string,
	onChunk?: (chunk: string) => void,
): Promise<string> {
	const model = modelId ? buildModel(modelId) : buildModel(DEFAULT_MODEL);

	const agent = new Agent();
	let reply = "(no reply)";

	const dialog = new DialogOrgan({
		sink: (text) => {
			if (text) {
				reply = text;
				onChunk?.(text);
			}
		},
		getTools: () => agent.tools,
		systemPrompt: META_SYSTEM_PROMPT,
	});

	const alefApi = createAlefApiOrgan();
	const llm = new Cerebrum({ model, timeoutMs: 60_000 });

	agent.load(dialog).load(alefApi).load(llm);
	await agent.ready();

	await dialog.send(prompt, "human", 60_000);
	agent.dispose();
	return reply;
}
