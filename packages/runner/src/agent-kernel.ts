import type { Organ } from "@dpopsuev/alef-kernel";
import { Agent } from "@dpopsuev/alef-runtime";
import { SessionLog } from "./event-log-organ.js";
import type { ActorIdentity } from "./identity/actor.js";
import { LoopGuard } from "./loop-detector.js";
import type { SessionStore } from "./session-store.js";

export interface AgentKernelOptions {
	llm: Organ;
	dialog?: Organ;
	trigger?: Organ;
	session?: SessionStore;
	modelId?: string;
	loopThreshold?: number;
	onLoop?: (eventType: string, reason: string) => void;
	/** Agent's visual identity — stamped on every StorageRecord by SessionLog. */
	agentIdentity?: ActorIdentity;
}

export interface AgentKernelResult {
	agent: Agent;
	dialog: Organ | undefined;
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
		agent.load(new SessionLog(opts.session, opts.modelId, opts.agentIdentity));
	}

	return { agent, dialog };
}

/** @deprecated Use buildAgent() */
export const AgentKernel = { create: buildAgent };
