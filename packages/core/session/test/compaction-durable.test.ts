import { describe, expect, it, vi } from "vitest";
import {
	alignCutIndex,
	compactMessages,
	createCompactionStage,
	estimateTokens,
	eventsAfterCompaction,
	findKeepStartIndex,
	latestCompaction,
} from "../src/context/compaction.js";
import type { SessionStore, StorageRecord } from "../src/contracts/storage.js";
import { hashRecord } from "../src/contracts/storage.js";

describe("createCompactionStage — reserveTokens trigger", { tags: ["unit"] }, () => {
	it("compacts when estimate exceeds window - reserveTokens", async () => {
		const publishSignal = vi.fn();
		const stage = createCompactionStage({
			contextWindow: 10_000,
			reserveTokens: 2_000,
			keepRecentTokens: 500,
			getLastTokenCount: () => 0,
			summarize: () => "summary",
			publishSignal,
		});

		const bulk = "x".repeat(20_000);
		const result = await stage({
			messages: [
				{ role: "user", content: bulk },
				{ role: "assistant", content: bulk },
				{ role: "user", content: "recent" },
			],
			tools: [],
			turn: 1,
		});

		expect(result.messages).toBeDefined();
		expect(publishSignal).toHaveBeenCalledWith(
			"context.compacted",
			expect.objectContaining({ compactedTurns: expect.any(Number) }),
		);
	});

	it("compacts when message estimate exceeds limit even if getLastTokenCount is stale low", async () => {
		const publishSignal = vi.fn();
		const stage = createCompactionStage({
			contextWindow: 10_000,
			threshold: 0.9,
			preserveRecentTurns: 2,
			getLastTokenCount: () => 1_000,
			summarize: () => "prior work summarized",
			publishSignal,
		});

		const bulk = "x".repeat(12_000);
		const result = await stage({
			messages: [
				{ role: "user", content: bulk },
				{ role: "assistant", content: bulk },
				{ role: "user", content: bulk },
				{ role: "assistant", content: bulk },
				{ role: "user", content: "keep recent user" },
				{ role: "assistant", content: "keep recent assistant" },
			],
			tools: [],
			turn: 1,
		});

		expect(result.messages, "must compact despite stale API token count").toBeDefined();
		expect(publishSignal).toHaveBeenCalledWith(
			"context.compacted",
			expect.objectContaining({ compactedTurns: expect.any(Number) }),
		);
	});
});

describe("cut alignment", { tags: ["unit"] }, () => {
	it("alignCutIndex does not land between tool_use and tool_result", () => {
		const messages = [
			{ role: "user", content: "a" },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "1", name: "fs.read" }],
			},
			{ role: "tool", content: [{ type: "tool_result", tool_use_id: "1", text: "ok" }] },
			{ role: "user", content: "b" },
		];
		expect(alignCutIndex(messages, 2)).toBe(1);
		expect(alignCutIndex(messages, 3)).toBe(3);
	});

	it("findKeepStartIndex keeps a recent tail within budget", () => {
		const messages = [
			{ role: "user", content: "x".repeat(400) },
			{ role: "assistant", content: "x".repeat(400) },
			{ role: "user", content: "recent" },
		];
		const { keepStart } = findKeepStartIndex(messages, 50);
		expect(keepStart).toBeGreaterThan(0);
		expect(keepStart).toBeLessThan(messages.length);
	});
});

describe("durable compaction", { tags: ["unit"] }, () => {
	it("persists context.compaction and reloads summary on next stage", async () => {
		const records: StorageRecord[] = [];
		const store: SessionStore = {
			id: "s1",
			path: "/tmp/s1",
			async append(record) {
				records.push({ ...record, hash: hashRecord(record) });
			},
			async events() {
				return records;
			},
			async turns() {
				return [];
			},
			async hitCounts() {
				return new Map();
			},
			async adapterHistory() {
				return [];
			},
			name: () => undefined,
			async setName() {},
			nameSource() {
				return undefined;
			},
			tags() {
				return [];
			},
			tagsSource() {
				return undefined;
			},
			async setTags() {},
			searchBlob() {
				return undefined;
			},
			async setSearchBlob() {},
		};

		const stage = createCompactionStage({
			contextWindow: 8_000,
			reserveTokens: 1_000,
			keepRecentTokens: 200,
			sessionStore: () => store,
			summarize: (_m, opts) => `SUM:${opts?.priorSummary ?? "none"}`,
			getLastTokenCount: () => 0,
		});

		const bulk = "y".repeat(16_000);
		await stage({
			messages: [
				{ role: "user", content: bulk },
				{ role: "assistant", content: bulk },
				{ role: "user", content: "tail" },
			],
			tools: [],
			turn: 1,
		});

		const compaction = latestCompaction(records);
		expect(compaction).toBeDefined();
		expect(compaction!.payload.summary).toMatch(/^SUM:/);

		const stage2 = createCompactionStage({
			contextWindow: 200_000,
			reserveTokens: 16_384,
			sessionStore: () => store,
			getLastTokenCount: () => 0,
		});
		const below = await stage2({
			messages: [{ role: "user", content: "hi" }],
			tools: [],
			turn: 2,
		});
		expect(below.messages?.[0]).toMatchObject({ role: "user", content: expect.stringMatching(/^SUM:/) });
	});

	it("eventsAfterCompaction returns events from firstKeptEventId", () => {
		const a: StorageRecord = {
			bus: "event",
			type: "llm.input",
			correlationId: "1",
			payload: { text: "old" },
			timestamp: 1,
		};
		a.hash = hashRecord(a);
		const b: StorageRecord = {
			bus: "command",
			type: "llm.response",
			correlationId: "1",
			payload: { text: "kept" },
			timestamp: 2,
		};
		b.hash = hashRecord(b);
		const compact: StorageRecord = {
			bus: "internal",
			type: "context.compaction",
			correlationId: "c",
			payload: { summary: "s", firstKeptEventId: b.hash },
			timestamp: 3,
		};
		expect(eventsAfterCompaction([a, b, compact], compact).map((e) => e.type)).toEqual([
			"llm.response",
			"context.compaction",
		]);
	});

	it("iterative compact passes prior summary into summarizer", async () => {
		const seen: Array<string | undefined> = [];
		const { result } = await compactMessages(
			[
				{ role: "user", content: "x".repeat(8_000) },
				{ role: "assistant", content: "x".repeat(8_000) },
				{ role: "user", content: "keep" },
			],
			{
				keepRecentTokens: 100,
				priorSummary: "earlier",
				summarize: (_m, opts) => {
					seen.push(opts?.priorSummary);
					return "next";
				},
				estimatedBefore: estimateTokens([
					{ role: "user", content: "x".repeat(8_000) },
					{ role: "assistant", content: "x".repeat(8_000) },
					{ role: "user", content: "keep" },
				]),
			},
		);
		expect(seen[0]).toBe("earlier");
		expect(result.summary).toBe("next");
	});

	it("force compact with instructions reaches summarizer", async () => {
		let got: string | undefined;
		const stage = createCompactionStage({
			contextWindow: 200_000,
			reserveTokens: 16_384,
			keepRecentTokens: 50,
			pullForceCompact: () => ({ instructions: "keep paths" }),
			summarize: (_m, opts) => {
				got = opts?.instructions;
				return "forced";
			},
			getLastTokenCount: () => 0,
		});
		await stage({
			messages: [
				{ role: "user", content: "x".repeat(4_000) },
				{ role: "assistant", content: "x".repeat(4_000) },
				{ role: "user", content: "now" },
			],
			tools: [],
			turn: 1,
		});
		expect(got).toBe("keep paths");
	});

	it("force compact under huge keep budget still summarizes via LLM path", async () => {
		let calls = 0;
		const stage = createCompactionStage({
			contextWindow: 200_000,
			reserveTokens: 16_384,
			keepRecentTokens: 1_000_000,
			pullForceCompact: () => ({ instructions: "force me" }),
			summarize: (_m, opts) => {
				calls++;
				expect(opts?.instructions).toBe("force me");
				return "## Goal\nForced summary";
			},
			getLastTokenCount: () => 0,
		});
		const out = await stage({
			messages: [
				{ role: "user", content: "a" },
				{ role: "assistant", content: "b" },
				{ role: "user", content: "c" },
			],
			tools: [],
			turn: 1,
		});
		expect(calls).toBe(1);
		expect(out.messages).toBeDefined();
		const texts = (out.messages ?? []).map((m) =>
			typeof (m as { content?: unknown }).content === "string" ? (m as { content: string }).content : "",
		);
		expect(texts.some((t) => t.includes("Forced summary"))).toBe(true);
		expect(texts.some((t) => t.includes("Manual compaction"))).toBe(false);
	});

	it("strategy=off skips auto compaction even over budget", async () => {
		let calls = 0;
		const stage = createCompactionStage({
			contextWindow: 1_000,
			reserveTokens: 100,
			strategy: "off",
			summarize: () => {
				calls++;
				return "should-not-run";
			},
			getLastTokenCount: () => 0,
		});
		const out = await stage({
			messages: [
				{ role: "user", content: "x".repeat(8_000) },
				{ role: "assistant", content: "y".repeat(8_000) },
			],
			tools: [],
			turn: 1,
		});
		expect(calls).toBe(0);
		expect(out.messages).toBeUndefined();
	});

	it("strategy=shake uses deterministic lead-in without summarizer", async () => {
		let calls = 0;
		const stage = createCompactionStage({
			contextWindow: 1_000,
			reserveTokens: 100,
			keepRecentTokens: 50,
			strategy: "shake",
			summarize: () => {
				calls++;
				return "llm-summary";
			},
			getLastTokenCount: () => 0,
		});
		const out = await stage({
			messages: [
				{ role: "user", content: "x".repeat(4_000) },
				{ role: "assistant", content: "y".repeat(4_000) },
				{ role: "user", content: "keep" },
			],
			tools: [],
			turn: 1,
		});
		expect(calls).toBe(0);
		const texts = (out.messages ?? []).map((m) =>
			typeof (m as { content?: unknown }).content === "string" ? (m as { content: string }).content : "",
		);
		expect(texts.some((t) => t.includes("Context shaken"))).toBe(true);
		expect(texts.some((t) => t.includes("llm-summary"))).toBe(false);
	});
});

describe("createCompactionStage — session metadata refresh", { tags: ["unit"] }, () => {
	function metaStore() {
		let name: string | undefined;
		let nameSource: "user" | "auto" | undefined;
		let tags: string[] = [];
		let tagsSource: "user" | "auto" | undefined;
		let searchBlob: string | undefined;
		const records: StorageRecord[] = [];
		const store: SessionStore = {
			id: "meta",
			path: "/tmp/meta",
			async append(record) {
				records.push(record);
			},
			async events() {
				return records;
			},
			async turns() {
				return [];
			},
			async hitCounts() {
				return new Map();
			},
			async adapterHistory() {
				return [];
			},
			name: () => name,
			nameSource: () => nameSource,
			async setName(next, options) {
				const source = options?.source ?? "user";
				if (source === "auto" && nameSource === "user") return;
				name = next;
				nameSource = source;
			},
			tags: () => tags,
			tagsSource() {
				return tagsSource;
			},
			async setTags(next, options) {
				const source = options?.source ?? "user";
				if (source === "auto" && tagsSource === "user") return;
				tags = [...next];
				tagsSource = source;
			},
			searchBlob: () => searchBlob,
			async setSearchBlob(blob) {
				searchBlob = blob;
			},
		};
		return {
			store,
			get name() {
				return name;
			},
			get nameSource() {
				return nameSource;
			},
			get tags() {
				return tags;
			},
			get searchBlob() {
				return searchBlob;
			},
		};
	}

	it("sets a provisional auto title from the first substantive user message", async () => {
		const meta = metaStore();
		const stage = createCompactionStage({
			contextWindow: 200_000,
			reserveTokens: 16_384,
			sessionStore: () => meta.store,
			getLastTokenCount: () => 0,
		});

		await stage({
			messages: [{ role: "user", content: "Fix the session picker rendering bug" }],
			tools: [],
			turn: 1,
		});

		expect(meta.name).toBe("Fix the session picker rendering bug");
		expect(meta.nameSource).toBe("auto");
	});

	it("refreshes title, tags, and search blob from compact summary", async () => {
		const meta = metaStore();
		const stage = createCompactionStage({
			contextWindow: 10_000,
			reserveTokens: 2_000,
			keepRecentTokens: 200,
			sessionStore: () => meta.store,
			getLastTokenCount: () => 0,
			summarize: () => `## Goal
Improve session discoverability

## Tags
tui, picker, compaction
`,
		});

		const bulk = "z".repeat(20_000);
		await stage({
			messages: [
				{ role: "user", content: bulk },
				{ role: "assistant", content: bulk },
				{ role: "user", content: "tail message for search" },
			],
			tools: [],
			turn: 1,
		});

		expect(meta.name).toBe("Improve session discoverability");
		expect(meta.nameSource).toBe("auto");
		expect(meta.tags).toEqual(["tui", "picker", "compaction"]);
		expect(meta.searchBlob).toContain("Improve session discoverability");
		expect(meta.searchBlob).toContain("tui");
		expect(meta.searchBlob).toContain("tail message for search");
	});

	it("does not overwrite a user-owned session name on compact", async () => {
		const meta = metaStore();
		await meta.store.setName("Manual title", { source: "user" });

		const stage = createCompactionStage({
			contextWindow: 10_000,
			reserveTokens: 2_000,
			keepRecentTokens: 200,
			sessionStore: () => meta.store,
			getLastTokenCount: () => 0,
			summarize: () => `## Goal
Auto title from summary

## Tags
auto-tag
`,
		});

		const bulk = "q".repeat(20_000);
		await stage({
			messages: [
				{ role: "user", content: bulk },
				{ role: "assistant", content: bulk },
				{ role: "user", content: "keep" },
			],
			tools: [],
			turn: 1,
		});

		expect(meta.name).toBe("Manual title");
		expect(meta.nameSource).toBe("user");
		expect(meta.tags).toEqual(["auto-tag"]);
	});

	it("injects tool format reminder after compaction summary", async () => {
		const stage = createCompactionStage({
			contextWindow: 10_000,
			reserveTokens: 2_000,
			keepRecentTokens: 200,
			getLastTokenCount: () => 0,
			summarize: () => "[Context compacted]",
		});

		const bulk = "x".repeat(20_000);
		const result = await stage({
			messages: [
				{ role: "system", content: "You are an assistant" },
				{ role: "user", content: bulk },
				{ role: "assistant", content: bulk },
				{ role: "user", content: "recent message" },
			],
			tools: [],
			turn: 1,
		});

		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		const messages = result.messages as Array<{ role: string; content: string }>;
		expect(messages).toBeDefined();

		// Find the assistant message with tool format reminder
		const reminderMessage = messages.find(
			(m) => m.role === "assistant" && m.content?.includes("function_calls"),
		);
		expect(reminderMessage).toBeDefined();
		expect(reminderMessage?.content).toContain("When making function calls");
		expect(reminderMessage?.content).toContain("<invoke");
		expect(reminderMessage?.content).toContain("<parameter");

		// Verify it comes after the summary and before kept messages
		const summaryIndex = messages.findIndex((m) => m.role === "user" && m.content === "[Context compacted]");
		const reminderIndex = messages.findIndex((m) => m === reminderMessage);
		expect(reminderIndex).toBeGreaterThan(summaryIndex);
	});
});
