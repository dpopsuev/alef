/**
 * AgentKernel.buildContextAssembler unit tests.
 *
 * The session-integration path is covered by lifecycle.test.ts.
 * These tests cover the pure logic: context window selection,
 * user message preservation, and the no-session pass-through.
 */

import type { Message } from "@dpopsuev/alef-ai";
import { describe, expect, it } from "vitest";
import { AgentKernel } from "../src/agent-kernel.js";

// ---------------------------------------------------------------------------
// Minimal SessionStore stub
// ---------------------------------------------------------------------------

function makeSession(turns: unknown[] = [], hitCounts: Record<string, number> = {}) {
	const appended: unknown[] = [];
	const session = {
		turns: async () => turns,
		hitCounts: async () => new Map(Object.entries(hitCounts)),
		append: async (r: unknown) => {
			appended.push(r);
		},
		_appended: appended,
	};
	return session as unknown as import("../src/session-store.js").SessionStore & { _appended: unknown[] };
}

const USER_MSG = { role: "user", content: "hello", timestamp: Date.now() } as Message;

// ---------------------------------------------------------------------------

describe("AgentKernel.buildContextAssembler", () => {
	it("pass-through when session is undefined", async () => {
		const fn = AgentKernel.buildContextAssembler(undefined, 100_000);
		const input = [USER_MSG];
		const result = await fn(input);
		expect(result).toBe(input);
	});

	it("pass-through when session has no turns", async () => {
		const fn = AgentKernel.buildContextAssembler(makeSession([]), 100_000);
		const input = [USER_MSG];
		const result = await fn(input);
		expect(result).toEqual(input);
	});

	it("preserves trailing user message when projected history exists", async () => {
		// Build a Turn with the correct shape: events[] containing a dialog.message.
		const pastTurn = {
			id: "old-turn",
			turnIndex: 0,
			tokenCost: 10,
			typeWeight: 0.8,
			events: [
				{
					id: "e1",
					correlationId: "old-turn",
					type: "motor",
					eventType: "dialog.message",
					payload: { text: "past question", role: "user" },
					timestamp: 1,
					hash: "h1",
				},
				{
					id: "e2",
					correlationId: "old-turn",
					type: "sense",
					eventType: "dialog.message",
					payload: {
						text: "past answer",
						role: "assistant",
						conversationHistory: [
							{ role: "user", content: "past question" },
							{ role: "assistant", content: "past answer" },
						],
					},
					timestamp: 2,
					hash: "h2",
				},
			],
		};
		const fn = AgentKernel.buildContextAssembler(makeSession([pastTurn] as unknown[]), 200_000);

		const currentUserMsg = { role: "user", content: "new question", timestamp: Date.now() } as Message;
		const result = await fn([currentUserMsg]);

		// When projected history exists, current user message must survive at the end.
		expect(result.at(-1)).toMatchObject({ role: "user", content: "new question" });
	});

	it("falls back to raw payload when session turns project to empty", async () => {
		// contextWindow so tiny that no turn fits.
		const bigTurn = {
			id: "t1",
			turnIndex: 0,
			tokenCost: 999_999,
			typeWeight: 1,
			events: [],
		};
		const fn = AgentKernel.buildContextAssembler(
			makeSession([bigTurn] as unknown[]),
			1, // contextWindow of 1 token — no turn fits
		);

		const input = [USER_MSG];
		const result = await fn(input);
		// Falls back to raw payload unchanged.
		expect(result).toEqual(input);
	});
});

describe("window.assembled LRU writes", () => {
	it("appends a window.assembled record after each prepareStep call", async () => {
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
						conversationHistory: [{ role: "user", content: "hello" }],
					},
					timestamp: 1,
				},
			],
		};
		const session = makeSession([turn] as unknown[]);
		const fn = AgentKernel.buildContextAssembler(session as import("../src/session-store.js").SessionStore, 200_000);

		await fn([USER_MSG]);

		// Give the fire-and-forget append a tick to complete.
		await new Promise((r) => setTimeout(r, 10));

		const appended = (session as unknown as { _appended: unknown[] })._appended;
		expect(appended).toHaveLength(1);
		const record = appended[0] as Record<string, unknown>;
		expect(record.bus).toBe("internal");
		expect(record.type).toBe("window.assembled");
		expect((record.payload as { includedTurnIds: string[] }).includedTurnIds).toContain("t1");
	});

	it("hitCounts become non-zero after two prepareStep calls with same turn", async () => {
		// Real SessionStore to verify hitCounts() actually reads window.assembled.
		const { mkdtempSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { rmSync } = await import("node:fs");
		const { SessionStore } = await import("../src/session-store.js");

		const cwd = mkdtempSync(join(tmpdir(), "alef-lru-"));
		try {
			const store = await SessionStore.create(cwd);
			// Write the turn event so turns() returns it.
			await store.append({
				bus: "motor",
				type: "dialog.message",
				correlationId: "t1",
				payload: { text: "hello", conversationHistory: [{ role: "user", content: "hello" }] },
				timestamp: 1,
			});

			const fn = AgentKernel.buildContextAssembler(store, 200_000);
			// First call — writes window.assembled for t1.
			await fn([USER_MSG]);
			await new Promise((r) => setTimeout(r, 20));
			// Second call — reads window.assembled, t1 should have hitCount=1.
			await fn([USER_MSG]);
			await new Promise((r) => setTimeout(r, 20));

			const counts = await store.hitCounts();
			expect(counts.get("t1")).toBeGreaterThanOrEqual(1);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
