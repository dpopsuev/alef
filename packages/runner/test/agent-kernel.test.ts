/**
 * AgentKernel.buildContextPrepareStep unit tests.
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
	return {
		turns: async () => turns,
		hitCounts: async () => hitCounts,
	} as unknown as import("../src/session-store.js").SessionStore;
}

const USER_MSG = { role: "user", content: "hello", timestamp: Date.now() } as Message;

// ---------------------------------------------------------------------------

describe("AgentKernel.buildContextPrepareStep", () => {
	it("pass-through when session is undefined", async () => {
		const fn = AgentKernel.buildContextPrepareStep(undefined, 100_000);
		const input = [USER_MSG];
		const result = await fn(input);
		expect(result).toBe(input);
	});

	it("pass-through when session has no turns", async () => {
		const fn = AgentKernel.buildContextPrepareStep(makeSession([]), 100_000);
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
		const fn = AgentKernel.buildContextPrepareStep(makeSession([pastTurn] as unknown[]), 200_000);

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
		const fn = AgentKernel.buildContextPrepareStep(
			makeSession([bigTurn] as unknown[]),
			1, // contextWindow of 1 token — no turn fits
		);

		const input = [USER_MSG];
		const result = await fn(input);
		// Falls back to raw payload unchanged.
		expect(result).toEqual(input);
	});
});
