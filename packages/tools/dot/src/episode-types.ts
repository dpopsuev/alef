import type { DotSnapshot } from "./world.js";

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
	"When the dot is still inside and you have completed several corrections, reply exactly: kept the dot in the circle",
].join(" ");

/** Outcome of one Dot episode (plant + intensity window). */
export interface EpisodeResult {
	readonly wakes: number;
	readonly final: DotSnapshot;
	readonly reason: "game_over" | "horizon" | "agent_done";
	readonly lastReply: string;
	/** Wall-clock ms while observe reported inside. */
	readonly insideMs: number;
	/** Wall-clock ms of the observation window (reset → final). */
	readonly totalMs: number;
}

/** Minimal send surface — BlueprintHarness, E2eSession, or any AgentController wrapper. */
export type EpisodeSend = (text: string) => Promise<string>;
