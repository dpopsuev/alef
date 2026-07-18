/**
 * Productized Dot consumer harness — scripted regression + live-LLM share
 * createDotConsumerEval / runConsumerSuite (baseline API in @dpopsuev/alef-eval).
 */
import { materializeBlueprint } from "@dpopsuev/alef-blueprint/materializer";
import {
	createDotConsumerEval,
	runConsumerSuite,
	type ProgressBusEvent,
} from "@dpopsuev/alef-eval/consumer";
import { buildConsumerRunRecord, generateScoreboard } from "@dpopsuev/alef-eval/scoreboard";
import { BlueprintHarness, createHeadlessSession, haveHeadlessLlm, step } from "@dpopsuev/alef-testkit";
import { afterEach, describe, expect, it } from "vitest";
import { spawnDotGameProcess, type SpawnedDotGame } from "../src/client.js";
import {
	DOT_DESIRED_STATE,
	DOT_GOAL,
	DOT_SYSTEM_PROMPT,
	runEpisode,
} from "../src/episode.js";
import { DotWorld } from "../src/world.js";
import { DOT_BLUEPRINT_PATH, DOT_PACKAGE_DIR, materializeDotAdapters } from "./load-dot-blueprint.js";

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function precomputeMoves(seed: number, horizon: number, force: number): Array<{ dx: number; dy: number }> {
	const world = new DotWorld({ seed, radius: 5, force, moveMax: 2 });
	const moves: Array<{ dx: number; dy: number }> = [];
	for (let i = 0; i < horizon; i++) {
		const snap = world.snapshot();
		const dx = clamp(-snap.x, -2, 2);
		const dy = clamp(-snap.y, -2, 2);
		moves.push({ dx, dy });
		world.move(dx, dy);
		if (world.snapshot().status === "game_over") break;
	}
	return moves;
}

describe("dot consumer eval — scripted", { tags: ["unit"] }, () => {
	const harnesses: BlueprintHarness[] = [];
	let game: SpawnedDotGame | undefined;
	const prevUrl = process.env.DOT_GAME_URL;

	afterEach(async () => {
		for (const h of harnesses.splice(0)) h.dispose();
		if (game) {
			await game.kill();
			game = undefined;
		}
		if (prevUrl === undefined) delete process.env.DOT_GAME_URL;
		else process.env.DOT_GAME_URL = prevUrl;
	});

	it("scripted mode: plant metrics + progress intensity via shared suite", async () => {
		const seed = 99;
		const force = 2.5;
		const moves = precomputeMoves(seed, 8, force);
		game = await spawnDotGameProcess({ seed, radius: 5, force });
		process.env.DOT_GAME_URL = game.baseUrl;

		const harness = await BlueprintHarness.fromBlueprint(DOT_BLUEPRINT_PATH, {
			materialize: materializeBlueprint,
			cwd: DOT_PACKAGE_DIR,
			script: [
				...moves.map((move) => step.toolCall("dot.move", move, "correcting")),
				step.reply("kept the dot in the circle"),
			],
			timeoutMs: 15_000,
		});
		harnesses.push(harness);

		const baseUrl = game.baseUrl;
		const adapter = createDotConsumerEval(async (mode) => {
			expect(mode).toBe("scripted");
			const events: ProgressBusEvent[] = [];
			const episode = await runEpisode({
				send: async (text) => {
					const reply = await harness.send({ text });
					for (const event of harness.notificationMessages) {
						// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- BusMessage base lacks payload; notifications carry it
						const payload = (event as { payload?: Record<string, unknown> }).payload;
						events.push({ type: event.type, payload });
					}
					return reply;
				},
				baseUrl,
				maxWakes: moves.length + 1,
				goal: DOT_GOAL,
				resetSeed: seed,
				stopOnReply: (reply) => reply.includes("kept the dot"),
			});
			return { episode, events };
		});

		const report = await runConsumerSuite({ mode: "scripted", adapters: [adapter] });
		expect(report.nPass).toBe(1);
		expect(report.results[0]!.metrics.terminal_inside).toBe(1);
		expect(report.results[0]!.metrics.progress_steps).toBeGreaterThan(0);
		expect(report.results[0]!.metrics.in_circle_ratio).toBeGreaterThanOrEqual(0.8);
		expect(report.results[0]!.progressSteps.length).toBeGreaterThan(0);

		const md = generateScoreboard([buildConsumerRunRecord("scripted", "harness", report.results)]);
		expect(md).toContain("Plant Metrics");
		expect(md).toContain("dot-circle");
	}, 60_000);
});

describe.skipIf(!haveHeadlessLlm())("dot consumer eval — live", { tags: ["real-llm"] }, () => {
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

	it("live mode: same suite API as scripted", async () => {
		const seed = 7;
		game = await spawnDotGameProcess({ seed, radius: 5, force: 2.0 });
		process.env.DOT_GAME_URL = game.baseUrl;

		const adapters = await materializeDotAdapters();
		const session = await createHeadlessSession(adapters, {
			systemPrompt: DOT_SYSTEM_PROMPT,
			timeoutMs: 90_000,
			desiredState: {
				intent: DOT_DESIRED_STATE.intent,
				dimensions: [...DOT_DESIRED_STATE.dimensions],
			},
		});

		try {
			const baseUrl = game.baseUrl;
			const adapter = createDotConsumerEval(async (mode) => {
				expect(mode).toBe("live");
				const events: ProgressBusEvent[] = [];
				const wakeGoal = [
					DOT_GOAL,
					"Use ONLY native tool calls for dot.observe and dot.move.",
					"Only when tick>=4 and still inside, reply exactly: kept the dot in the circle",
				].join(" ");
				const episode = await runEpisode({
					send: async (text) => {
						const { reply, events: wakeEvents } = await session.send(text);
						for (const event of wakeEvents) {
							events.push({
								type: event.type,
								payload: event.payload as Record<string, unknown>,
							});
						}
						return reply;
					},
					baseUrl,
					maxWakes: 8,
					goal: wakeGoal,
					resetSeed: seed,
					stopOnReply: (reply, snap) => snap.tick >= 4 && /kept the dot in the circle/i.test(reply),
				});
				return { episode, events };
			});

			const report = await runConsumerSuite({ mode: "live", adapters: [adapter] });
			expect(report.mode).toBe("live");
			expect(report.results[0]!.metrics.progress_steps).toBeGreaterThan(0);
			expect(report.results[0]!.metrics.terminal_inside).toBe(1);
		} finally {
			await session.dispose();
		}
	}, 300_000);
});
