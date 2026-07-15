import { LoopGuard } from "@dpopsuev/alef-agent/loop-detector";
import { Agent } from "@dpopsuev/alef-engine/agent";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import type { AgentBus } from "@dpopsuev/alef-kernel/bus";
import type { SessionStore } from "@dpopsuev/alef-session/storage";
import { SessionLog, type SessionSummary } from "./event-log-adapter.js";
import type { ActorIdentity } from "./identity/actor.js";
import { type GapSnapshot, ProgressTelemetry } from "./progress-telemetry.js";

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
	/** Override gap accessor; default ducks ReconciliationSurface on llm. */
	getGap?: () => GapSnapshot | null;
}

/** Duck-type ErrorTensor from createAgentLoop when present. */
function gapFromLlm(llm: Adapter): () => GapSnapshot | null {
	const surface = llm as Adapter & {
		getErrorTensor?: () => { totalMagnitude: number; converged: boolean } | null;
		recompute?: () => unknown;
	};
	if (typeof surface.getErrorTensor !== "function") {
		return () => null;
	}
	return () => {
		surface.recompute?.();
		const tensor = surface.getErrorTensor?.();
		if (!tensor) return null;
		return { totalMagnitude: tensor.totalMagnitude, converged: tensor.converged };
	};
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

	agent.load(new ProgressTelemetry({ getGap: opts.getGap ?? gapFromLlm(opts.llm) }));

	if (opts.session) {
		agent.load(new SessionLog(opts.session, opts.modelId, opts.agentIdentity, opts.summaryWriter));
	}

	return agent;
}
