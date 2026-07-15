import { createDotGameClient } from "../src/client.js";
import type { DotSnapshot } from "../src/world.js";

export const DOT_GOAL = "Keep the dot in the circle";

/** Desired state for ProgressTelemetry / ErrorTensor on dot episodes. */
export const DOT_DESIRED_STATE = {
	intent: DOT_GOAL,
	dimensions: [{ domain: "dot", key: "inside", target: true, priority: 1 }],
} as const;

/** System prompt for real-LLM / blueprint episodes. */
export const DOT_SYSTEM_PROMPT = [
	"You control a dot that must stay inside a circle centered at the origin.",
	"Use dot.observe to read x, y, dist, inside, status, tick.",
	"Use dot.move with dx, dy (each clamped to ±2) toward the origin to counteract drift: prefer dx≈-x, dy≈-y.",
	"After each move the world applies random drift — keep correcting.",
	"If status is game_over the episode failed.",
	'When the dot is still inside and you have completed several corrections, reply exactly: kept the dot in the circle',
].join(" ");

export interface EpisodeResult {
	readonly wakes: number;
	readonly final: DotSnapshot;
	readonly reason: "game_over" | "horizon" | "agent_done";
	readonly lastReply: string;
}

/** Minimal send surface — BlueprintHarness, E2eSession, or any AgentController wrapper. */
export type EpisodeSend = (text: string) => Promise<string>;

/**
 * Episode supervisor: wake the agent until the remote game ends or the horizon hits.
 * Does not import Alef reasoner internals — only a send callback + game HTTP client.
 */
export async function runEpisode(opts: {
	readonly send: EpisodeSend;
	readonly baseUrl: string;
	readonly maxWakes: number;
	readonly goal?: string;
	readonly stopOnReply?: (reply: string, snap: DotSnapshot) => boolean;
	readonly resetSeed?: number;
}): Promise<EpisodeResult> {
	const client = createDotGameClient(opts.baseUrl);
	const goal = opts.goal ?? DOT_GOAL;
	let wakes = 0;
	let lastReply = "";

	await client.reset(opts.resetSeed);
	const started = await client.observe();
	if (started.status === "game_over") {
		return { wakes: 0, final: started, reason: "game_over", lastReply: "" };
	}

	for (let wake = 0; wake < opts.maxWakes; wake++) {
		wakes += 1;
		lastReply = await opts.send(goal);

		const snap = await client.observe();
		if (snap.status === "game_over" || !snap.inside) {
			return { wakes, final: snap, reason: "game_over", lastReply };
		}
		if (opts.stopOnReply?.(lastReply, snap)) {
			return { wakes, final: snap, reason: "agent_done", lastReply };
		}
	}

	const final = await client.observe();
	return {
		wakes,
		final,
		reason: final.status === "game_over" ? "game_over" : "horizon",
		lastReply,
	};
}
