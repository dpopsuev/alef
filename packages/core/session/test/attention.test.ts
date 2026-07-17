import { describe, expect, it, vi } from "vitest";
import {
	attendMessages,
	cosineSimilarity,
	mergeBidirectionalScores,
	partitionAttentionTurns,
	selectAttentionTurns,
} from "../src/context/attention.js";
import { createCompactionStage, estimateTokens } from "../src/context/compaction.js";

describe("attention — pure selection", { tags: ["unit"] }, () => {
	it("cosineSimilarity is 1 for identical unit vectors", () => {
		expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
		expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
		expect(cosineSimilarity([], [1])).toBe(0);
	});

	it("mergeBidirectionalScores takes max per turn", () => {
		const merged = mergeBidirectionalScores(
			new Map([
				["a", 0.2],
				["b", 0.9],
			]),
			new Map([
				["a", 0.8],
				["c", 0.5],
			]),
		);
		expect(merged.get("a")).toBe(0.8);
		expect(merged.get("b")).toBe(0.9);
		expect(merged.get("c")).toBe(0.5);
	});

	it("partitionAttentionTurns groups user-started turns and keeps system", () => {
		const { system, turns } = partitionAttentionTurns([
			{ role: "system", content: "sys" },
			{ role: "user", content: "u1" },
			{ role: "assistant", content: "a1" },
			{ role: "user", content: "u2" },
			{ role: "assistant", content: "a2" },
		]);
		expect(system).toHaveLength(1);
		expect(turns).toHaveLength(2);
		expect(turns[0]?.messages).toHaveLength(2);
		expect(turns[1]?.messages).toHaveLength(2);
	});

	it("selectAttentionTurns pins recent and keeps highest scores under budget", () => {
		const turns = [
			{ id: "turn-0", index: 0, messages: [{ role: "user", content: "old noise ".repeat(40) }], tokenCost: 80, text: "old noise" },
			{ id: "turn-1", index: 1, messages: [{ role: "user", content: "relevant topic ".repeat(40) }], tokenCost: 80, text: "relevant" },
			{ id: "turn-2", index: 2, messages: [{ role: "user", content: "other ".repeat(40) }], tokenCost: 80, text: "other" },
			{ id: "turn-3", index: 3, messages: [{ role: "user", content: "recent ".repeat(20) }], tokenCost: 40, text: "recent" },
			{ id: "turn-4", index: 4, messages: [{ role: "user", content: "latest ".repeat(20) }], tokenCost: 40, text: "latest" },
		];
		const { selected, result } = selectAttentionTurns(turns, {
			tokenLimit: 160,
			pinRecentTurns: 2,
			similarityWeight: 1,
			similarityByTurnId: new Map([
				["turn-0", 0.1],
				["turn-1", 0.99],
				["turn-2", 0.2],
				["turn-3", 0.3],
				["turn-4", 0.3],
			]),
		});
		const ids = selected.map((t) => t.id);
		expect(ids).toContain("turn-3");
		expect(ids).toContain("turn-4");
		expect(ids).toContain("turn-1");
		expect(ids).not.toContain("turn-0");
		expect(result.droppedTurnIds).toContain("turn-0");
		expect(result.keptTurnIds).toEqual(ids);
	});

	it("attendMessages drops low-score turns and preserves chronological order", async () => {
		const messages = [
			{ role: "system", content: "system" },
			{ role: "user", content: "alpha noise ".repeat(50) },
			{ role: "assistant", content: "ack alpha" },
			{ role: "user", content: "beta important ".repeat(50) },
			{ role: "assistant", content: "ack beta" },
			{ role: "user", content: "gamma noise ".repeat(50) },
			{ role: "assistant", content: "ack gamma" },
			{ role: "user", content: "current ask" },
		];
		const before = estimateTokens(messages);
		const { messages: after, result } = await attendMessages(messages, {
			tokenLimit: Math.floor(before * 0.55),
			pinRecentTurns: 1,
			similarityWeight: 1,
			scoreTurns: async (turns) => {
				const scores = new Map<string, number>();
				for (const turn of turns) {
					scores.set(turn.id, turn.text.includes("beta important") ? 1 : 0.05);
				}
				return scores;
			},
		});
		expect(result.droppedTurnIds.length).toBeGreaterThan(0);
		expect(estimateTokens(after)).toBeLessThan(before);
		const texts = after.map((m) => (typeof m === "object" && m && "content" in m ? String((m as { content: unknown }).content) : ""));
		expect(texts.some((t) => t.includes("beta important"))).toBe(true);
		expect(texts.at(-1)).toContain("current ask");
		const betaAt = texts.findIndex((t) => t.includes("beta important"));
		const currentAt = texts.findIndex((t) => t.includes("current ask"));
		expect(betaAt).toBeGreaterThan(-1);
		expect(currentAt).toBeGreaterThan(betaAt);
	});
});

describe("createCompactionStage — attention strategy", { tags: ["unit"] }, () => {
	it("keeps high-score turns and does not append compaction summary to store", async () => {
		const append = vi.fn(async () => {});
		const store = {
			events: async () => [],
			name: () => "test",
			append,
		};
		const signals: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const stage = createCompactionStage({
			contextWindow: 400,
			reserveTokens: 0,
			strategy: "attention",
			sessionStore: () => store as never,
			publishSignal: (type, payload) => signals.push({ type, payload }),
			scoreAttentionTurns: async (turns) => {
				const scores = new Map<string, number>();
				for (const turn of turns) {
					scores.set(turn.id, turn.text.includes("KEEP") ? 1 : 0);
				}
				return scores;
			},
			attentionPinRecentTurns: 1,
		});

		const messages = [
			{ role: "system", content: "sys" },
			{ role: "user", content: `DROP ${"x".repeat(800)}` },
			{ role: "assistant", content: "dropped reply" },
			{ role: "user", content: `KEEP ${"y".repeat(800)}` },
			{ role: "assistant", content: "kept reply" },
			{ role: "user", content: `recent ${"z".repeat(200)}` },
		];

		const result = await stage({ messages, tools: [], turn: 1 });
		expect(result.messages).toBeDefined();
		const out = result.messages as Array<{ role: string; content: string }>;
		const joined = out.map((m) => m.content).join("\n");
		expect(joined).toContain("KEEP");
		expect(joined).toContain("recent");
		expect(joined).not.toContain("DROP");
		expect(append).not.toHaveBeenCalled();
		expect(signals.some((s) => s.type === "context.attention")).toBe(true);
		const attention = signals.find((s) => s.type === "context.attention");
		expect(attention?.payload.dropped).toEqual(expect.arrayContaining([expect.any(String)]));
	});

	it("leaves store history intact when turns are dropped from the window", async () => {
		const events = [
			{ bus: "event" as const, type: "llm.input", correlationId: "c1", payload: { text: "old" }, timestamp: 1 },
			{ bus: "event" as const, type: "llm.input", correlationId: "c2", payload: { text: "new" }, timestamp: 2 },
		];
		const store = {
			events: async () => events,
			name: () => "test",
			append: async () => {},
		};
		const stage = createCompactionStage({
			contextWindow: 500,
			reserveTokens: 0,
			strategy: "attention",
			sessionStore: () => store as never,
			scoreAttentionTurns: async (turns) => new Map(turns.map((t) => [t.id, t.index === turns.length - 1 ? 1 : 0])),
			attentionPinRecentTurns: 1,
		});
		const messages = [
			{ role: "user", content: "a".repeat(400) },
			{ role: "assistant", content: "b".repeat(400) },
			{ role: "user", content: "c".repeat(100) },
		];
		await stage({ messages, tools: [], turn: 1 });
		expect(await store.events()).toHaveLength(2);
		expect((await store.events())[0]?.payload.text).toBe("old");
	});
});
