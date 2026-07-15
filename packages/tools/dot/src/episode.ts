import { createDotGameClient } from "./client.js";
import type { DotSnapshot } from "./world.js";
import {
	DOT_GOAL,
	type EpisodeResult,
	type EpisodeSend,
} from "./episode-types.js";

export {
	DOT_DESIRED_STATE,
	DOT_GOAL,
	DOT_SYSTEM_PROMPT,
	type EpisodeResult,
	type EpisodeSend,
} from "./episode-types.js";

/**
 * Episode supervisor: wake the agent until the remote game ends or the horizon hits.
 * Does not import Alef reasoner internals — only a send callback + game HTTP client.
 * Tracks wall-clock in-circle time for plant metrics.
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
	let insideMs = 0;
	let lastSampleAt = Date.now();

	await client.reset(opts.resetSeed);
	const started = await client.observe();
	const windowStart = Date.now();
	lastSampleAt = windowStart;
	if (started.status === "game_over") {
		return {
			wakes: 0,
			final: started,
			reason: "game_over",
			lastReply: "",
			insideMs: 0,
			totalMs: Date.now() - windowStart,
		};
	}

	const accrue = (snap: DotSnapshot): void => {
		const now = Date.now();
		const delta = now - lastSampleAt;
		if (snap.inside && snap.status === "ok") insideMs += delta;
		lastSampleAt = now;
	};

	for (let wake = 0; wake < opts.maxWakes; wake++) {
		wakes += 1;
		lastReply = await opts.send(goal);

		const snap = await client.observe();
		accrue(snap);
		if (snap.status === "game_over" || !snap.inside) {
			return {
				wakes,
				final: snap,
				reason: "game_over",
				lastReply,
				insideMs,
				totalMs: Date.now() - windowStart,
			};
		}
		if (opts.stopOnReply?.(lastReply, snap)) {
			return {
				wakes,
				final: snap,
				reason: "agent_done",
				lastReply,
				insideMs,
				totalMs: Date.now() - windowStart,
			};
		}
	}

	const final = await client.observe();
	accrue(final);
	return {
		wakes,
		final,
		reason: final.status === "game_over" ? "game_over" : "horizon",
		lastReply,
		insideMs,
		totalMs: Date.now() - windowStart,
	};
}
