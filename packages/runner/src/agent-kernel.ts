/**
 * AgentKernel — canonical construction of the mandatory agent infrastructure.
 *
 * Replaces the divergent agent.load() chains scattered across main.ts,
 * BlueprintHarness, and EvalHarness. Every site that boots an Alef agent
 * calls AgentKernel.create() and gets the same mandatory wiring.
 *
 * Mandatory components (never in a blueprint manifest):
 *   DialogOrgan      — conversation boundary, session history, MESSAGE_TOOL
 *   Reasoner         — reasoning loop (or ScriptedReasoner in tests)
 *   LoopGuard — safety watchdog, aborts runaway tool loops
 *   SessionLog    — write-ahead log to session JSONL (optional: needs session)
 *
 * Corpus organs (optional, manifest-declared) are loaded by the caller via
 *   kernel.load(organ)
 * after create() returns.
 *
 * ALE-SPC-24
 */

import { Agent } from "@dpopsuev/alef-corpus";
import { type ConversationMessage, DialogOrgan, type MessageSink } from "@dpopsuev/alef-organ-dialog";
import type { Message } from "@dpopsuev/alef-organ-llm";
import type { Organ } from "@dpopsuev/alef-spine";
import { SessionLog } from "./event-log-organ.js";
import { LoopGuard } from "./loop-detector.js";
import type { SessionStore } from "./session-store.js";
import { assembleTurns, turnsToMessages } from "./turn-assembler.js";

export interface AgentKernelOptions {
	/**
	 * The reasoning organ: Reasoner in production, ScriptedReasoner in tests.
	 */
	llm: Organ;
	/**
	 * The trigger organ — the organ whose external-facing sensory detector
	 * injects events into the spine to activate the Reasoner.
	 *
	 * Default: DialogOrgan (conversation-driven agent, sense/dialog.message trigger).
	 * Override for autonomous agents: GitEventOrgan, CronOrgan, MetricAlertOrgan, etc.
	 *
	 * When trigger is provided, the sink/systemPrompt/maxTurns options are ignored
	 * (they are DialogOrgan-specific). The returned dialog will be undefined.
	 */
	trigger?: Organ;

	/** Sink for outbound Motor/dialog.message events. */
	sink?: MessageSink;

	/** Returns all tools the LLM may call. Pass () => agent.tools. */
	getTools?: () => ReturnType<Agent["tools"]["slice"]>;

	/** System prompt prepended to every conversation turn. */
	systemPrompt?: string;

	/** Maximum number of user turns per session. 0 = unlimited. */
	maxTurns?: number;

	/**
	 * Session store for SessionLog. Omit to skip event logging
	 * (e.g. in unit tests where persistence is not needed).
	 */
	session?: SessionStore;
	/** Model identifier written into the session summary. */
	modelId?: string;

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
	/**
	 * The dialog organ — use dialog.send() to drive turns.
	 * Undefined when a custom trigger organ was provided (non-conversation agent).
	 */
	dialog: DialogOrgan | undefined;
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
	/**
	 * Build a prepareStep function that assembles the context window from the
	 * session JSONL before each LLM call. Pass the result to ReasonerOptions.
	 *
	 * When session is undefined (test path), returns a pass-through.
	 */
	buildContextPrepareStep(
		session: SessionStore | undefined,
		contextWindow: number,
	): (messages: Message[]) => Promise<Message[]> {
		if (!session) return (msgs) => Promise.resolve(msgs);
		return async (messages: Message[]): Promise<Message[]> => {
			const turns = await session.turns();
			const hitCounts = await session.hitCounts();
			const lastMsg = messages.at(-1);
			const query =
				lastMsg && typeof (lastMsg as { content?: unknown }).content === "string"
					? (lastMsg as { content: string }).content
					: "";
			const selected = assembleTurns(turns, { query, contextWindow, hitCounts });
			const projected = turnsToMessages(selected);
			if (projected.length === 0) return messages;
			const currentMsg = messages.at(-1);
			if (currentMsg && (currentMsg as { role?: string }).role === "user") {
				return [...projected, currentMsg] as Message[];
			}
			return projected;
		};
	},

	create(opts: AgentKernelOptions): AgentKernelResult {
		const agent = new Agent();

		// Use the provided trigger organ, or default to DialogOrgan for conversation agents.
		let dialog: DialogOrgan | undefined;
		if (opts.trigger) {
			agent.load(opts.trigger).load(opts.llm);
		} else {
			dialog = new DialogOrgan({
				sink: opts.sink ?? (() => {}),
				getTools: opts.getTools ?? (() => agent.tools),
				systemPrompt: opts.systemPrompt,
				maxTurns: opts.maxTurns,
				initialHistory: opts.initialHistory,
				onMessage: opts.onMessage,
			});
			agent.load(dialog).load(opts.llm);
		}

		agent.load(
			new LoopGuard({
				repeatedInteractionThreshold: opts.loopThreshold,
				onLoop: opts.onLoop,
			}),
		);

		if (opts.session) {
			agent.load(new SessionLog(opts.session, opts.modelId));
		}

		return { agent, dialog };
	},
};
