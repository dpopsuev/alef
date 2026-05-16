/**
 * bootAgent — creates and wires the standard agent organ stack.
 *
 * Returns an AgentSession: the running agent plus its dialog boundary.
 * Call session.dispose() when done — always, even on error.
 */

import type { Api, Model } from "@dpopsuev/alef-ai";
import { Agent } from "@dpopsuev/alef-corpus";
import { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import { createFsOrgan } from "@dpopsuev/alef-organ-fs";
import { LLMOrgan } from "@dpopsuev/alef-organ-llm";
import { createShellOrgan } from "@dpopsuev/alef-organ-shell";

export interface BootOptions {
	/** Working directory for FsOrgan and ShellOrgan. */
	cwd: string;
	/** Model to use for the LLMOrgan. */
	model: Model<Api>;
	/** Optional system prompt. */
	systemPrompt?: string;
}

export interface AgentSession {
	/** The running agent instance. */
	agent: Agent;
	/** The dialog boundary — use send() to interact. */
	dialog: DialogOrgan;
	/** Tear down all organs cleanly. Always call this, even on error. */
	dispose(): void;
}

export function bootAgent(opts: BootOptions): AgentSession {
	const agent = new Agent();

	const dialog = new DialogOrgan({
		sink: (text) => console.log(text),
		getTools: () => agent.tools,
		systemPrompt: opts.systemPrompt,
	});

	agent
		.load(dialog)
		.load(createFsOrgan({ cwd: opts.cwd }))
		.load(createShellOrgan({ cwd: opts.cwd }))
		.load(new LLMOrgan({ model: opts.model }));

	return {
		agent,
		dialog,
		dispose: () => agent.dispose(),
	};
}
