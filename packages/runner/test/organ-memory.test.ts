/**
 * MemoryOrgan unit tests — Phase 1 skeleton.
 *
 * Verifies:
 *   - organ mounts, satisfies contract (name, tools, subscriptions)
 *   - participates in llm.phase pipeline with empty response (no messages field)
 *   - does not override ToolShell messages in a two-stage pipeline
 *
 * Ref: ALE-SPC-55, ALE-TSK-457
 */

import { randomUUID } from "node:crypto";
import { InProcessNerve } from "@dpopsuev/alef-spine";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryOrgan } from "../src/organ-memory.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mountOrgan(organ: ReturnType<typeof createMemoryOrgan>) {
	const nerve = new InProcessNerve();
	const unmount = organ.mount(nerve.asNerve());
	return { nerve, unmount };
}

function firePhase(nerve: InProcessNerve, messages: unknown[]): Promise<Record<string, unknown> | null> {
	return new Promise((resolve) => {
		const correlationId = randomUUID();
		const timer = setTimeout(() => resolve(null), 500);
		const off = nerve.asNerve().sense.subscribe("llm.phase", (event) => {
			if (event.correlationId !== correlationId) return;
			clearTimeout(timer);
			off();
			resolve(event.payload as Record<string, unknown>);
		});
		nerve.asNerve().motor.publish({
			type: "llm.phase",
			payload: { messages, turn: 1, toolCount: 0 },
			correlationId,
		});
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MemoryOrgan — Phase 2 context assembly", () => {
	const disposes: Array<() => void> = [];
	afterEach(() => {
		for (const d of disposes.splice(0)) d();
	});

	it("returns messages when session has turns with history", async () => {
		const turn = {
			id: "t1",
			turnIndex: 0,
			tokenCost: 10,
			typeWeight: 0.8,
			events: [
				{
					bus: "motor",
					type: "dialog.message",
					correlationId: "t1",
					payload: {
						text: "hello",
						conversationHistory: [
							{ role: "user", content: "hello" },
							{ role: "assistant", content: "hi there" },
						],
					},
					timestamp: 1,
				},
			],
		};
		const session = {
			turns: async () => [turn],
			hitCounts: async () => new Map<string, number>(),
			append: async () => {},
		};
		const organ = createMemoryOrgan({
			sessionStore: () => session as never,
			contextWindow: 200_000,
		});
		const { nerve, unmount } = mountOrgan(organ);
		disposes.push(unmount);

		const msgs = [
			{ role: "system", content: "system prompt" },
			{ role: "user", content: "new question" },
		];
		const payload = await firePhase(nerve, msgs);
		expect(payload).not.toBeNull();
		expect(payload).toHaveProperty("messages");
		const assembled = payload!.messages as Array<{ role: string; content: unknown }>;
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
		const { nerve, unmount } = mountOrgan(organ);
		disposes.push(unmount);

		const payload = await firePhase(nerve, [{ role: "user", content: "hi" }]);
		expect(payload).not.toHaveProperty("messages");
	});

	it("writes window.assembled to session after assembly", async () => {
		const appended: unknown[] = [];
		const turn = {
			id: "t1",
			turnIndex: 0,
			tokenCost: 10,
			typeWeight: 0.8,
			events: [
				{
					bus: "motor",
					type: "dialog.message",
					correlationId: "t1",
					payload: { text: "hello", conversationHistory: [{ role: "user", content: "hello" }] },
					timestamp: 1,
				},
			],
		};
		const session = {
			turns: async () => [turn],
			hitCounts: async () => new Map<string, number>(),
			append: async (r: unknown) => {
				appended.push(r);
			},
		};
		const organ = createMemoryOrgan({ sessionStore: () => session as never, contextWindow: 200_000 });
		const { nerve, unmount } = mountOrgan(organ);
		disposes.push(unmount);

		await firePhase(nerve, [{ role: "user", content: "hello" }]);
		await new Promise((r) => setTimeout(r, 20));

		const record = appended.find((r) => (r as { type: string }).type === "window.assembled");
		expect(record).toBeDefined();
		expect((record as { payload: { includedTurnIds: string[] } }).payload.includedTurnIds).toContain("t1");
	});
});

describe("MemoryOrgan — Phase 1 skeleton", () => {
	const disposes: Array<() => void> = [];
	afterEach(() => {
		for (const d of disposes.splice(0)) d();
	});

	it("has name=memory and no LLM-callable tools", () => {
		const organ = createMemoryOrgan();
		expect(organ.name).toBe("memory");
		expect(organ.tools).toHaveLength(0);
	});

	it("subscribes to motor/llm.phase", () => {
		const organ = createMemoryOrgan();
		expect(organ.subscriptions.motor).toContain("llm.phase");
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

	it("publishes sense/llm.phase with no messages field on each motor/llm.phase event", async () => {
		const organ = createMemoryOrgan();
		const { nerve, unmount } = mountOrgan(organ);
		disposes.push(unmount);

		const payload = await firePhase(nerve, [{ role: "user", content: "hello" }]);
		expect(payload).not.toBeNull();
		// Phase 1: empty response — messages key must be absent so ToolShell wins.
		expect(payload).not.toHaveProperty("messages");
	});

	it("does not block the pipeline when sessionStore is absent", async () => {
		const organ = createMemoryOrgan({ sessionStore: () => undefined });
		const { nerve, unmount } = mountOrgan(organ);
		disposes.push(unmount);

		const payload = await firePhase(nerve, []);
		expect(payload).not.toBeNull();
	});
});
