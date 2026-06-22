import type { Organ } from "@dpopsuev/alef-kernel";
import { Agent } from "@dpopsuev/alef-runtime";
import { SessionLog } from "./event-log-organ.js";
import type { ActorIdentity } from "./identity/actor.js";
import { LoopGuard } from "./loop-detector.js";
import type { JsonlSessionStore } from "./session-store.js";

export interface AgentKernelOptions {
	llm: Organ;
	session?: JsonlSessionStore;
	modelId?: string;
	loopThreshold?: number;
	onLoop?: (eventType: string, reason: string) => void;
	agentIdentity?: ActorIdentity;
}

export function buildAgent(opts: AgentKernelOptions): Agent {
	const agent = new Agent();

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

	return agent;
}
