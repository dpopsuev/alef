import { createSessionContextStage } from "@dpopsuev/alef-session/context";
import { describe, expect, it } from "vitest";

describe("Session context stage", { tags: ["unit"] }, () => {
	it("returns empty result when sessionStore returns undefined", async () => {
		const stage = createSessionContextStage({ sessionStore: () => undefined as never });
		const result = await stage({ messages: [], tools: [], turn: 1 });
		expect(result).not.toHaveProperty("messages");
	});

	function makeTurn(id: string, history: unknown[]) {
		return {
			id,
			turnIndex: 0,
			tokenCost: 10,
			typeWeight: 0.8,
			events: [
				{
					bus: "command",
					type: "llm.response",
					correlationId: id,
					payload: { text: "hello", conversationHistory: history },
					timestamp: 1,
				},
			],
		};
	}

	it("returns messages when session has turns with history", async () => {
		const turn = makeTurn("t1", [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi there" },
		]);
		const session = {
			turns: async () => [turn],
			hitCounts: async () => new Map<string, number>(),
			append: async () => {},
		};
		const stage = createSessionContextStage({ sessionStore: () => session as never, contextWindow: 200_000 });

		const msgs = [
			{ role: "system", content: "system prompt" },
			{ role: "user", content: "new question" },
		];
		const result = await stage({ messages: msgs as never, tools: [], turn: 1 });
		expect(result).toHaveProperty("messages");
		const assembled = result.messages as Array<{ role: string; content: unknown }>;
		expect(assembled.at(0)?.role).toBe("system");
		expect(assembled.at(-1)).toMatchObject({ role: "user", content: "new question" });
	});

	it("does not append toolResult as currentUserMsg on tool round 2+", async () => {
		const toolResultMsg = { role: "toolResult", toolCallId: "call-1", content: "file contents" };
		const conversationHistory = [
			{ role: "user", content: "read a file" },
			{ role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "fs.read", input: {} }] },
			toolResultMsg,
		];
		const turnWithCheckpoint = {
			id: "t1",
			turnIndex: 0,
			tokenCost: 50,
			typeWeight: 0.8,
			events: [
				{
					bus: "internal",
					type: "llm.checkpoint",
					correlationId: "t1",
					payload: { conversationHistory },
					timestamp: 1,
				},
			],
		};
		const session = {
			turns: async () => [turnWithCheckpoint],
			hitCounts: async () => new Map<string, number>(),
			append: async () => {},
		};
		const stage = createSessionContextStage({ sessionStore: () => session as never, contextWindow: 200_000 });

		const msgs = [
			{ role: "system", content: "system prompt" },
			{ role: "user", content: "read a file" },
			{ role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "fs.read", input: {} }] },
			toolResultMsg,
		];
		const result = await stage({ messages: msgs as never, tools: [], turn: 2 });
		if (!result.messages) return;
		const assembled = result.messages as Array<{ role: string; toolCallId?: string }>;
		const ids = assembled.filter((m) => m.role === "toolResult").map((m) => m.toolCallId);
		const unique = new Set(ids);
		expect(ids.length).toBe(unique.size);
	});

	it("returns empty result when session has no turns", async () => {
		const session = {
			turns: async () => [],
			hitCounts: async () => new Map<string, number>(),
			append: async () => {},
		};
		const stage = createSessionContextStage({ sessionStore: () => session as never, contextWindow: 200_000 });

		const result = await stage({ messages: [{ role: "user", content: "hi" }] as never, tools: [], turn: 1 });
		expect(result).not.toHaveProperty("messages");
	});

	it("writes window.assembled to session after assembly", async () => {
		const appended: unknown[] = [];
		const turn = makeTurn("t1", [{ role: "user", content: "hello" }]);
		const session = {
			turns: async () => [turn],
			hitCounts: async () => new Map<string, number>(),
			append: async (r: unknown) => {
				appended.push(r);
			},
		};
		const stage = createSessionContextStage({ sessionStore: () => session as never, contextWindow: 200_000 });

		await stage({ messages: [{ role: "user", content: "hello" }] as never, tools: [], turn: 1 });
		await new Promise((r) => setTimeout(r, 20));

		const record = appended.find((r) => (r as { type: string }).type === "window.assembled");
		expect(record).toBeDefined();
		expect((record as { payload: { includedTurnIds: string[] } }).payload.includedTurnIds).toContain("t1");
	});

	it("budgetUsed in window.assembled never exceeds budgetTotal", async () => {
		const appended: unknown[] = [];
		const contextWindow = 140_000;

		const heavyTurn = {
			id: "explore",
			turnIndex: 0,
			tokenCost: 600_000,
			typeWeight: 0.8,
			events: [
				{
					bus: "command",
					type: "llm.response",
					correlationId: "explore",
					payload: { text: "ok", conversationHistory: [{ role: "user", content: "explore" }] },
					timestamp: 1,
				},
			],
		};
		const session = {
			turns: async () => [heavyTurn],
			hitCounts: async () => new Map<string, number>(),
			append: async (r: unknown) => {
				appended.push(r);
			},
		};
		const stage = createSessionContextStage({ sessionStore: () => session as never, contextWindow });

		await stage({ messages: [{ role: "user", content: "what did you find" }] as never, tools: [], turn: 1 });
		await new Promise((r) => setTimeout(r, 20));

		const record = appended.find((r) => (r as { type: string }).type === "window.assembled") as
			| { payload: { budgetUsed: number; budgetTotal: number } }
			| undefined;
		expect(record).toBeDefined();

		const { budgetUsed, budgetTotal } = record!.payload;
		expect(budgetUsed).toBeLessThanOrEqual(budgetTotal);
	});
});
