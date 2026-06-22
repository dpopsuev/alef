import type { Organ } from "@dpopsuev/alef-kernel";
import { Agent } from "@dpopsuev/alef-runtime";
import { SessionLog, type SessionSummary } from "./event-log-organ.js";
import type { ActorIdentity } from "./identity/actor.js";
import { LoopGuard } from "./loop-detector.js";
import type { SessionStore } from "./session-store.js";

export interface AgentKernelOptions {
	llm: Organ;
	session?: SessionStore;
	modelId?: string;
	loopThreshold?: number;
	onLoop?: (eventType: string, reason: string) => void;
	agentIdentity?: ActorIdentity;
	summaryWriter?: (summary: SessionSummary) => void | Promise<void>;
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
		agent.load(new SessionLog(opts.session, opts.modelId, opts.agentIdentity, opts.summaryWriter));
	}

	return agent;
}
