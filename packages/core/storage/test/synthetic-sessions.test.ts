import { afterEach, describe, expect, it } from "vitest";
import {
	createSeededRng,
	createSyntheticCorpus,
	expandSessionSpecs,
	generateSyntheticEvents,
	resolveTurnCount,
} from "./helpers/synthetic-sessions.js";

describe("synthetic session generator", { tags: ["unit"] }, () => {
	it("seeded rng is deterministic", () => {
		const a = createSeededRng(42);
		const b = createSeededRng(42);
		expect([a(), a(), a()]).toEqual([b(), b(), b()]);
	});

	it("expandSessionSpecs cycles profiles and names", () => {
		const specs = expandSessionSpecs({
			cwd: "/tmp/alef-synth",
			sessions: 8,
			profileMix: ["tiny", "heavy"],
		});
		expect(specs).toHaveLength(8);
		expect(specs[0]!.profile).toBe("tiny");
		expect(specs[1]!.profile).toBe("heavy");
		expect(specs[0]!.name).toContain("#1");
		expect(new Set(specs.map((s) => s.name)).size).toBe(8);
	});

	it("generateSyntheticEvents includes transcript + boot noise", () => {
		const events = generateSyntheticEvents({
			profile: "noisy",
			turns: 3,
			seed: 7,
			baseTimestamp: 1_000,
			topic: "picker lag",
		});
		expect(events.some((e) => e.type === "adapter.loaded")).toBe(true);
		expect(events.filter((e) => e.type === "llm.input")).toHaveLength(3);
		expect(events.filter((e) => e.type === "llm.result")).toHaveLength(3);
		expect(events.some((e) => e.type === "llm.chunk")).toBe(true);
		expect(events.some((e) => e.bus === "command")).toBe(true);
	});

	it("resolveTurnCount respects profile defaults and overrides", () => {
		expect(resolveTurnCount("tiny")).toBe(3);
		expect(resolveTurnCount("heavy")).toBe(28);
		expect(resolveTurnCount("medium", 5)).toBe(5);
	});
});

describe("createSyntheticCorpus", { tags: ["integration"] }, () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const fn of cleanups.splice(0)) fn();
	});

	it("materializes listable sessions with projectable previews", async () => {
		const corpus = await createSyntheticCorpus({
			cwd: "/tmp/alef-synth-a",
			altCwd: "/tmp/alef-synth-b",
			sessions: 6,
			profileMix: ["tiny", "medium", "heavy", "noisy"],
		});
		cleanups.push(corpus.cleanup);

		expect(corpus.stats.sessionCount).toBe(6);
		expect(corpus.stats.totalEvents).toBeGreaterThan(50);
		expect(corpus.stats.byProfile.tiny).toBeGreaterThan(0);
		expect(corpus.stats.byProfile.heavy).toBeGreaterThan(0);

		const listed = await corpus.list();
		expect(listed.length).toBeGreaterThanOrEqual(4); // altCwd sessions excluded from cwd list
		expect(listed.every((entry) => entry.name)).toBe(true);
		expect(listed.some((entry) => entry.searchBlob)).toBe(true);
		expect(listed.some((entry) => entry.tags?.length)).toBe(true);

		const all = await corpus.listAll();
		expect(all).toHaveLength(6);

		const heavy = corpus.sessions.find((session) => session.profile === "heavy");
		expect(heavy).toBeDefined();
		const preview = await corpus.preview.getSessionPreview(heavy!.id, 5);
		expect(preview.some((block) => block.kind === "user")).toBe(true);
		expect(preview.some((block) => block.kind === "assistant")).toBe(true);
		expect(preview.some((block) => block.kind === "tool")).toBe(true);
		expect(preview.length).toBeGreaterThan(5);
	});

	it("explicit specs control turns and names", async () => {
		const corpus = await createSyntheticCorpus({
			cwd: "/tmp/alef-synth-explicit",
			sessions: [
				{ name: "Alpha", profile: "tiny", turns: 2, tags: ["alpha"] },
				{ name: "Beta", profile: "medium", turns: 4, tags: ["beta"] },
			],
		});
		cleanups.push(corpus.cleanup);

		expect(corpus.sessions.map((s) => s.name)).toEqual(["Alpha", "Beta"]);
		expect(corpus.sessions[0]!.turnCount).toBe(2);
		expect(corpus.sessions[1]!.turnCount).toBe(4);

		const preview = await corpus.preview.getSessionPreview(corpus.sessions[0]!.id, 10);
		const users = preview.filter((block) => block.kind === "user");
		expect(users).toHaveLength(2);
	});
});
