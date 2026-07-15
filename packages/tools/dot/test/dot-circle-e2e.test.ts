import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { materializeBlueprint } from "@dpopsuev/alef-blueprint/materializer";
import { adapterComplianceSuite, BlueprintHarness, step } from "@dpopsuev/alef-testkit";
import { afterEach, describe, expect, it } from "vitest";
import type { BusMessage } from "@dpopsuev/alef-kernel/bus";
import { createAdapter } from "../src/adapter.js";
import { createDotGameClient, spawnDotGameProcess, type SpawnedDotGame } from "../src/client.js";
import { startDotGameServer, type DotGameServer } from "../src/game-server.js";
import { DotWorld } from "../src/world.js";
import { DOT_GOAL, runEpisode } from "./episode.js";

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

/** Precompute control impulses for a known seed (scripted E2E — decisions outside Alef). */
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

process.env.DOT_GAME_URL ??= "http://127.0.0.1:9";
adapterComplianceSuite(() => createAdapter({ cwd: "/tmp" }));

describe("dot plant (no Alef)", { tags: ["unit"] }, () => {
	it("open-loop death — zero control + drift reaches game_over", () => {
		const world = new DotWorld({ seed: 42, radius: 5, force: 3, moveMax: 2 });
		let snap = world.snapshot();
		for (let i = 0; i < 40 && snap.status !== "game_over"; i++) {
			snap = world.move(0, 0);
		}
		expect(snap.status).toBe("game_over");
		expect(snap.inside).toBe(false);
	});
});

describe("dot HTTP plant", { tags: ["unit"] }, () => {
	let server: DotGameServer | undefined;
	afterEach(async () => {
		if (server) {
			await server.close();
			server = undefined;
		}
	});

	it("heuristic survive via game client alone", async () => {
		server = await startDotGameServer({ seed: 7, radius: 5, force: 2.5 });
		const client = createDotGameClient(server.baseUrl);
		for (let i = 0; i < 25; i++) {
			const observed = await client.observe();
			expect(observed.status).toBe("ok");
			const moved = await client.move(clamp(-observed.x, -2, 2), clamp(-observed.y, -2, 2));
			expect(moved.status).toBe("ok");
		}
		expect((await client.observe()).inside).toBe(true);
	});
});

describe("dot-circle E2E — blueprint + spawned game", { tags: ["unit"] }, () => {
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

	it("open-loop death against spawned game process", async () => {
		game = await spawnDotGameProcess({ seed: 42, radius: 5, force: 3 });
		const client = createDotGameClient(game.baseUrl);
		await client.reset(42);
		let snap = await client.observe();
		for (let i = 0; i < 40 && snap.status !== "game_over"; i++) {
			snap = await client.move(0, 0);
		}
		expect(snap.status).toBe("game_over");
	}, 20_000);

	it("episode wakes via BlueprintHarness.send until agent_done", async () => {
		const seed = 99;
		const force = 2.5;
		const moves = precomputeMoves(seed, 8, force);
		expect(moves.length).toBeGreaterThan(0);

		game = await spawnDotGameProcess({ seed, radius: 5, force });
		process.env.DOT_GAME_URL = game.baseUrl;

		const adapterPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
		const cwd = mkdtempSync(join(tmpdir(), "dot-e2e-"));
		const blueprintPath = join(cwd, "agent.yaml");
		writeFileSync(
			blueprintPath,
			[
				"name: dot-circle-agent",
				"systemPrompt: |",
				"  Keep the dot inside the circle.",
				"  Use dot.observe and dot.move toward the origin (±2).",
				"adapters:",
				`  - path: ${adapterPath}`,
			].join("\n"),
		);

		const harness = await BlueprintHarness.fromBlueprint(blueprintPath, {
			materialize: materializeBlueprint,
			cwd,
			script: [
				...moves.map((move) => step.toolCall("dot.move", move, "correcting")),
				step.reply("kept the dot in the circle"),
			],
			timeoutMs: 15_000,
		});
		harnesses.push(harness);

		const progressSteps: BusMessage[] = [];
		const result = await runEpisode({
			send: async (text) => {
				const reply = await harness.send({ text });
				progressSteps.push(
					...harness.notificationMessages.filter((event) => event.type === "telemetry.progress.step"),
				);
				return reply;
			},
			baseUrl: game.baseUrl,
			maxWakes: moves.length + 1,
			goal: DOT_GOAL,
			stopOnReply: (reply) => reply.includes("kept the dot"),
		});

		expect(result.reason).toBe("agent_done");
		expect(result.lastReply).toContain("kept the dot");
		expect(result.final.status).toBe("ok");
		expect(result.final.inside).toBe(true);
		expect(result.wakes).toBeGreaterThan(0);
		expect(progressSteps.length, "ProgressTelemetry should emit step events").toBeGreaterThan(0);
	}, 60_000);
});
