import { LoopGuard } from "@dpopsuev/alef-agent/loop-detector";
import { Agent } from "@dpopsuev/alef-engine/agent";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import type { AgentBus } from "@dpopsuev/alef-kernel/bus";
import type { SessionStore } from "@dpopsuev/alef-session/storage";
import { SessionLog, type SessionSummary } from "./event-log-adapter.js";
import type { ActorIdentity } from "./identity/actor.js";

/**
 *
 */
export interface AgentKernelOptions {
	llm: Adapter;
	session?: SessionStore;
	modelId?: string;
	loopThreshold?: number;
	onLoop?: (eventType: string, reason: string) => void;
	agentIdentity?: ActorIdentity;
	summaryWriter?: (summary: SessionSummary) => void | Promise<void>;
	bus?: AgentBus;
}

/**
 *
 */
export function buildAgent(opts: AgentKernelOptions): Agent {
	const agent = new Agent({ bus: opts.bus });

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
