import { InProcessNerve } from "@dpopsuev/alef-spine";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryOrgan } from "../src/organ-memory.js";

function mountOrgan(organ: ReturnType<typeof createMemoryOrgan>) {
	const nerve = new InProcessNerve();
	const unmount = organ.mount(nerve.asNerve());
	return { nerve, unmount };
}

describe("MemoryOrgan — organ contract", () => {
	const disposes: Array<() => void> = [];
	afterEach(() => {
		for (const d of disposes.splice(0)) d();
	});

	it("has name=memory and no LLM-callable tools", () => {
		const organ = createMemoryOrgan();
		expect(organ.name).toBe("memory");
		expect(organ.tools).toHaveLength(0);
	});

	it("does not subscribe to motor/llm.phase — pipeline coordinator owns that", () => {
		const organ = createMemoryOrgan();
		expect(organ.subscriptions.motor).not.toContain("llm.phase");
	});

	it("exposes phaseStage() returning a function", () => {
		const organ = createMemoryOrgan();
		expect(typeof organ.phaseStage()).toBe("function");
	});

	it("mount returns a cleanup function and unmount is idempotent", () => {
		const organ = createMemoryOrgan();
		const { unmount } = mountOrgan(organ);
		disposes.push(unmount);
		expect(() => {
			unmount();
			unmount();
		}).not.toThrow();
	});

	it("phaseStage returns empty result when sessionStore is absent", async () => {
		const organ = createMemoryOrgan({ sessionStore: () => undefined });
		const stage = organ.phaseStage();
		const result = await stage({ messages: [], tools: [], turn: 1 });
		expect(result).not.toHaveProperty("messages");
	});
});

describe("MemoryOrgan — Phase 2 context assembly", () => {
	function makeTurn(id: string, history: unknown[]) {
		return {
			id,
			turnIndex: 0,
			tokenCost: 10,
			typeWeight: 0.8,
			events: [
				{
					bus: "motor",
					type: "dialog.message",
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
		const organ = createMemoryOrgan({ sessionStore: () => session as never, contextWindow: 200_000 });
		const stage = organ.phaseStage();

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

	it("returns empty result when session has no turns", async () => {
		const session = {
			turns: async () => [],
			hitCounts: async () => new Map<string, number>(),
			append: async () => {},
		};
		const organ = createMemoryOrgan({ sessionStore: () => session as never, contextWindow: 200_000 });
		const stage = organ.phaseStage();

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
		const organ = createMemoryOrgan({ sessionStore: () => session as never, contextWindow: 200_000 });
		const stage = organ.phaseStage();

		await stage({ messages: [{ role: "user", content: "hello" }] as never, tools: [], turn: 1 });
		await new Promise((r) => setTimeout(r, 20));

		const record = appended.find((r) => (r as { type: string }).type === "window.assembled");
		expect(record).toBeDefined();
		expect((record as { payload: { includedTurnIds: string[] } }).payload.includedTurnIds).toContain("t1");
	});
});
