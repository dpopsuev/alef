/**
 * AgentKernel — canonical construction of the mandatory agent infrastructure.
 *
 * Replaces the divergent agent.load() chains scattered across main.ts,
 * BlueprintHarness, and EvalHarness. Every site that boots an Alef agent
 * calls AgentKernel.create() and gets the same mandatory wiring.
 *
 * Mandatory components (never in a blueprint manifest):
 *   DialogOrgan      — conversation boundary, session history, MESSAGE_TOOL
 *   LLMOrgan         — reasoning loop (or ScriptedLLMOrgan in tests)
 *   LoopDetectorOrgan — safety watchdog, aborts runaway tool loops
 *   EventLogOrgan    — write-ahead log to session JSONL (optional: needs session)
 *
 * Corpus organs (optional, manifest-declared) are loaded by the caller via
 *   kernel.load(organ)
 * after create() returns.
 *
 * ALE-SPC-24
 */

import { Agent } from "@dpopsuev/alef-corpus";
import { type ConversationMessage, DialogOrgan, type MessageSink } from "@dpopsuev/alef-organ-dialog";
import type { Organ } from "@dpopsuev/alef-spine";
import { EventLogOrgan } from "./event-log-organ.js";
import { LoopDetectorOrgan } from "./loop-detector.js";
import type { SessionStore } from "./session-store.js";

export interface AgentKernelOptions {
	/**
	 * The reasoning organ: LLMOrgan in production, ScriptedLLMOrgan in tests.
	 * Required — without it the agent cannot respond to dialog.message.
	 */
	llm: Organ;

	/** Sink for outbound Motor/dialog.message events. */
	sink?: MessageSink;

	/** Returns all tools the LLM may call. Pass () => agent.tools. */
	getTools?: () => ReturnType<Agent["tools"]["slice"]>;

	/** System prompt prepended to every conversation turn. */
	systemPrompt?: string;

	/** Maximum number of user turns per session. 0 = unlimited. */
	maxTurns?: number;

	/**
	 * Session store for EventLogOrgan. Omit to skip event logging
	 * (e.g. in unit tests where persistence is not needed).
	 */
	session?: SessionStore;

	/**
	 * Maximum number of identical (tool, args, result) triples before the
	 * loop guard fires. Default: 3.
	 */
	loopThreshold?: number;

	/**
	 * Called when a loop is detected. Default: write to stderr and abort via
	 * the provided controller.
	 */
	onLoop?: (eventType: string, reason: string) => void;

	/** Seed conversation history (e.g. from a resumed session). */
	initialHistory?: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;

	/** Called when a message is appended to history (for session persistence). */
	onMessage?: (msg: ConversationMessage) => void;
}

export interface AgentKernelResult {
	agent: Agent;
	/** The dialog organ — use dialog.send() to drive turns. */
	dialog: DialogOrgan;
}

/**
 * Construct the mandatory kernel and return the wired agent + dialog handle.
 *
 * After create(), load corpus organs:
 *   const { agent, dialog } = AgentKernel.create(opts);
 *   for (const organ of corpusOrgans) agent.load(organ);
 *   agent.validate();
 */
export const AgentKernel = {
	create(opts: AgentKernelOptions): AgentKernelResult {
		const agent = new Agent();

		const dialog = new DialogOrgan({
			sink: opts.sink ?? (() => {}),
			getTools: opts.getTools ?? (() => agent.tools),
			systemPrompt: opts.systemPrompt,
			maxTurns: opts.maxTurns,
			initialHistory: opts.initialHistory,
			onMessage: opts.onMessage,
		});

		agent.load(dialog).load(opts.llm);

		agent.load(
			new LoopDetectorOrgan({
				repeatedInteractionThreshold: opts.loopThreshold,
				onLoop: opts.onLoop,
			}),
		);

		if (opts.session) {
			agent.load(new EventLogOrgan(opts.session));
		}

		return { agent, dialog };
	},
};
