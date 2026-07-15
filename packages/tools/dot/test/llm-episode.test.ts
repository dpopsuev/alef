/**
 * Real-LLM episode — Alef agent keeps the remote dot inside the circle.
 *
 * Gate: ALEF_TEST_LLM=1 + credentials (haveHeadlessLlm).
 * Plant: spawned game process. Agent: createHeadlessSession + createDotAdapter.
 */
import { createHeadlessSession, haveHeadlessLlm } from "@dpopsuev/alef-testkit";
import { afterEach, describe, expect, it } from "vitest";
import { createDotAdapter } from "../src/adapter.js";
import { spawnDotGameProcess, type SpawnedDotGame } from "../src/client.js";
import { DOT_DESIRED_STATE, DOT_GOAL, DOT_SYSTEM_PROMPT, runEpisode } from "../src/episode.js";

describe.skipIf(!haveHeadlessLlm())("dot-circle — real LLM episode", { tags: ["real-llm"] }, () => {
	let game: SpawnedDotGame | undefined;
	const prevUrl = process.env.DOT_GAME_URL;

	afterEach(async () => {
		if (game) {
			await game.kill();
			game = undefined;
		}
		if (prevUrl === undefined) delete process.env.DOT_GAME_URL;
		else process.env.DOT_GAME_URL = prevUrl;
	});

	it("multi-wake episode — LLM keeps the dot inside until agent_done or horizon", async () => {
		const seed = 7;
		game = await spawnDotGameProcess({ seed, radius: 5, force: 2.0 });
		process.env.DOT_GAME_URL = game.baseUrl;

		const adapter = createDotAdapter({ baseUrl: game.baseUrl });
		const session = await createHeadlessSession([adapter], {
			systemPrompt: DOT_SYSTEM_PROMPT,
			timeoutMs: 90_000,
			desiredState: {
				intent: DOT_DESIRED_STATE.intent,
				dimensions: [...DOT_DESIRED_STATE.dimensions],
			},
		});

		const toolStarts: string[] = [];
		const progressSteps: Array<Record<string, unknown>> = [];
		try {
			const wakeGoal = [
				DOT_GOAL,
				"Use ONLY native tool calls for dot.observe and dot.move — never write XML or fake tool markup in your text.",
				"Each wake: call dot.observe once, then if needed one dot.move toward the origin (dx≈-x, dy≈-y, ±2).",
				"Then reply with a one-line status including tick.",
				"Only when tick>=4 and still inside, reply exactly: kept the dot in the circle",
			].join(" ");

			const result = await runEpisode({
				send: async (text) => {
					const { reply, events } = await session.send(text);
					for (const event of events) {
						if (event.type === "llm.tool-start") {
							toolStarts.push(String(event.payload.name ?? ""));
						}
						if (event.type === "telemetry.progress.step") {
							progressSteps.push(event.payload);
						}
					}
					return reply;
				},
				baseUrl: game.baseUrl,
				maxWakes: 8,
				goal: wakeGoal,
				resetSeed: seed,
				stopOnReply: (reply, snap) => snap.tick >= 4 && /kept the dot in the circle/i.test(reply),
			});

			expect(
				toolStarts.some((name) => name.includes("dot.")),
				`expected native dot.* tool calls; got toolStarts=[${toolStarts.join(",")}] lastReply=${result.lastReply}`,
			).toBe(true);
			expect(progressSteps.length, "expected telemetry.progress.step from ProgressTelemetry").toBeGreaterThan(0);
			expect(progressSteps[0]).toHaveProperty("tokens");
			expect(progressSteps[0]).toHaveProperty("tok_per_progress");
			expect(result.reason, JSON.stringify(result)).not.toBe("game_over");
			expect(result.final.inside, JSON.stringify(result)).toBe(true);
			expect(result.final.status).toBe("ok");
			expect(result.final.tick, `reply=${result.lastReply} tools=${toolStarts.join(",")}`).toBeGreaterThanOrEqual(
				1,
			);
			expect(result.wakes).toBeGreaterThan(0);
			expect(["agent_done", "horizon"]).toContain(result.reason);
		} finally {
			await session.dispose();
		}
	}, 300_000);
});
