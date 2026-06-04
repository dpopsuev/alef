import type { Message } from "@dpopsuev/alef-ai";
import { Agent } from "@dpopsuev/alef-corpus";
import type { Organ } from "@dpopsuev/alef-spine";
import { SessionLog } from "./event-log-organ.js";
import { LoopGuard } from "./loop-detector.js";
import type { SessionStore } from "./session-store.js";

export type CheckpointCallback = (messages: Message[], correlationId: string) => void;

export interface AgentKernelOptions {
	llm: Organ;
	dialog?: Organ;
	trigger?: Organ;
	session?: SessionStore;
	modelId?: string;
	loopThreshold?: number;
	onLoop?: (eventType: string, reason: string) => void;
}

export interface AgentKernelResult {
	agent: Agent;
	dialog: Organ | undefined;
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
	const dialog = opts.dialog ?? opts.trigger;

	if (dialog) agent.load(dialog);
	agent.load(opts.llm);

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
