/**
 * Session history eager load in chat view.
 *
 * Given/When/Then:
 *   Given a JsonlSessionStore with prior llm.input + llm.response turns
 *   When buildLayout is called with that store
 *   Then the chat Container contains user + agent pill components before first send()
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionStore } from "@dpopsuev/alef-session/store";
import { Container } from "@dpopsuev/alef-tui";
import { ChatLog, prependSessionHistory } from "@dpopsuev/alef-tui/views";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getTheme } from "../src/client/theme.js";

describe("prependSessionHistory — eager load prior turns into chat", { tags: ["unit"] }, () => {
	let cwd: string;
	let store: JsonlSessionStore;

	beforeEach(async () => {
		cwd = mkdtempSync(join(tmpdir(), "alef-hist-load-"));
		store = await JsonlSessionStore.create(cwd);
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	async function appendTurn(userText: string, agentText: string): Promise<void> {
		const corrId = randomUUID();
		await store.append({
			bus: "event",
			type: "llm.input",
			correlationId: corrId,
			payload: { text: userText, sender: "human" },
			timestamp: Date.now(),
		});
		await store.append({
			bus: "command",
			type: "llm.response",
			correlationId: corrId,
			payload: {
				text: agentText,
				conversationHistory: [
					{ role: "user", content: userText },
					{ role: "assistant", content: agentText },
				],
			},
			timestamp: Date.now() + 100,
		});
	}

	it("prepends up to 5 most recent turns as chat components", async () => {
		await appendTurn("turn 1 question", "turn 1 answer");
		await appendTurn("turn 2 question", "turn 2 answer");

		const chat = new Container();
		const writer = new ChatLog(chat, getTheme());

		await prependSessionHistory(store, writer, { maxTurns: 5 });

		// After prepend, chat should have children for the loaded turns.
		expect(chat.children.length).toBeGreaterThan(0);
	});

	it("prepends nothing when store has no prior turns", async () => {
		const chat = new Container();
		const writer = new ChatLog(chat, getTheme());

		await prependSessionHistory(store, writer, { maxTurns: 5 });

		expect(chat.children.length).toBe(0);
	});

	it("respects maxTurns limit", async () => {
		// Add 7 turns
		for (let i = 1; i <= 7; i++) {
			await appendTurn(`question ${i}`, `answer ${i}`);
		}

		const chatAll = new Container();
		const writerAll = new ChatLog(chatAll, getTheme());
		await prependSessionHistory(store, writerAll, { maxTurns: 7 });

		const chatFew = new Container();
		const writerFew = new ChatLog(chatFew, getTheme());
		await prependSessionHistory(store, writerFew, { maxTurns: 3 });

		// More turns = more components
		expect(chatAll.children.length).toBeGreaterThan(chatFew.children.length);
	});
});
