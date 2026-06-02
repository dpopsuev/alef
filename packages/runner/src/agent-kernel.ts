import { Agent } from "@dpopsuev/alef-corpus";
import { DialogOrgan, type MessageSink } from "@dpopsuev/alef-organ-dialog";
import type { Message } from "@dpopsuev/alef-organ-llm";
import type { Organ, SessionStore } from "@dpopsuev/alef-spine";
import { SessionLog } from "./event-log-organ.js";
import { LoopGuard } from "./loop-detector.js";

export type CheckpointCallback = (messages: Message[], correlationId: string) => void;

export interface AgentKernelOptions {
	llm: Organ;
	dialog?: DialogOrgan;
	trigger?: Organ;
	/** @deprecated Pass dialog instead. */
	sink?: MessageSink;
	session?: SessionStore;
	modelId?: string;
	loopThreshold?: number;
	onLoop?: (eventType: string, reason: string) => void;
}

export interface AgentKernelResult {
	agent: Agent;
	dialog: DialogOrgan | undefined;
}

export function buildCheckpointCallback(
	getSession: (() => SessionStore | undefined) | undefined,
): CheckpointCallback | undefined {
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
}

export function buildAgent(opts: AgentKernelOptions): AgentKernelResult {
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
}

/** @deprecated Use buildAgent() */
export const AgentKernel = {
	buildCheckpointCallback,
	create: buildAgent,
};
