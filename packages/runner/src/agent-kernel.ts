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
import { DialogOrgan, type MessageSink } from "@dpopsuev/alef-organ-dialog";
import type { Message } from "@dpopsuev/alef-organ-llm";
import type { Organ, SessionStore } from "@dpopsuev/alef-spine";
import { SessionLog } from "./event-log-organ.js";
import { LoopGuard } from "./loop-detector.js";
import { assembleTurns, turnsToMessages } from "./turn-assembler.js";

export type CheckpointCallback = (messages: Message[], correlationId: string) => void;

export interface AgentKernelOptions {
	/**
	 * The reasoning organ: Reasoner in production, ScriptedReasoner in tests.
	 */
	llm: Organ;
	/**
	 * Pre-constructed dialog organ. When provided, it is mounted directly — no
	 * internal DialogOrgan construction. Preferred over the legacy sink/systemPrompt/maxTurns
	 * path which constructs DialogOrgan internally (DI violation).
	 */
	dialog?: DialogOrgan;

	/**
	 * Non-dialog trigger organ for autonomous agents (GitEventOrgan, CronOrgan, etc.).
	 * Mutually exclusive with dialog. The returned dialog will be undefined.
	 */
	trigger?: Organ;

	/** @deprecated Pass dialog instead. Ignored when dialog is provided. */
	sink?: MessageSink;
	/** @deprecated Pass dialog instead. Ignored when dialog is provided. */
	getTools?: () => ReturnType<Agent["tools"]["slice"]>;
	/** @deprecated Pass dialog instead. Ignored when dialog is provided. */
	systemPrompt?: string;
	/** @deprecated Pass dialog instead. Ignored when dialog is provided. */
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
	 * Build the onCheckpoint callback to pass to Cerebrum.
	 * Writes a durable internal/llm.checkpoint record to the session after each
	 * tool round so turnsToMessages can recover context on abort (ALE-TSK-368).
	 * Returns undefined when session is absent — Cerebrum skips the callback.
	 */
	buildCheckpointCallback(getSession: (() => SessionStore | undefined) | undefined): CheckpointCallback | undefined {
		if (!getSession) return undefined;
		return (messages: Message[], correlationId: string) => {
			const session = getSession();
			if (!session) return;
			void session.append({
				bus: "internal",
				type: "llm.checkpoint",
				correlationId,
				payload: { conversationHistory: messages as unknown as Record<string, unknown>[] },
				timestamp: Date.now(),
			});
		};
	},

	buildContextAssembler(
		getSession: (() => SessionStore | undefined) | undefined,
		contextWindow: number,
	): (messages: Message[]) => Promise<Message[]> {
		if (!getSession) return (msgs) => Promise.resolve(msgs);
		return async (messages: Message[]): Promise<Message[]> => {
			const session = getSession();
			if (!session) return messages;
			const turns = await session.turns();
			const hitCounts = await session.hitCounts();
			const lastMsg = messages.at(-1);
			const query =
				lastMsg && typeof (lastMsg as { content?: unknown }).content === "string"
					? (lastMsg as { content: string }).content
					: "";
			const selected = assembleTurns(turns, { query, contextWindow, hitCounts });

			const budgetTotal = Math.floor(contextWindow * 0.7);
			const budgetUsed = selected.reduce((n, t) => n + t.tokenCost, 0);
			void session.append({
				bus: "internal",
				type: "window.assembled",
				correlationId: `wa-${Date.now()}`,
				payload: {
					includedTurnIds: selected.map((t) => t.id),
					queryTokens: query
						.toLowerCase()
						.split(/\W+/)
						.filter((t) => t.length > 2),
					budgetUsed,
					budgetTotal,
				},
				timestamp: Date.now(),
			});

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
		let dialog: DialogOrgan | undefined;

		if (opts.dialog) {
			dialog = opts.dialog;
			agent.load(dialog).load(opts.llm);
		} else if (opts.trigger) {
			agent.load(opts.trigger).load(opts.llm);
		} else {
			dialog = new DialogOrgan({ sink: opts.sink ?? (() => {}) });
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
