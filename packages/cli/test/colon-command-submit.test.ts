/**
 * Regression test: colon commands typed in insert mode and submitted via Enter
 * must be dispatched to the command registry, not sent as LLM prompts.
 *
 * Root cause: InputPatternRegistry has "/" and "@" patterns but no ":" pattern.
 * Text like ":theme dark" falls through to executeMessage() and is sent to the LLM.
 */

import { describe, expect, it } from "vitest";
import type { SubmitConfig } from "../src/client/submit.js";
import { createSubmitHandler } from "../src/client/submit.js";

function makeStubConfig() {
	const sent: string[] = [];
	const notices: string[] = [];
	const userMessages: string[] = [];
	const agentReplies: string[] = [];
	const dispatched: Array<{ type: string }> = [];
	const history: string[] = [];
	let cleared = 0;

	return {
		config: {
			actorRoutes: undefined,
			session: {
				state: { contextWindow: 100_000 },
				send: async (text: string) => {
					sent.push(text);
				},
				setTurnController: () => {},
				cancelToolCall: () => {},
			},
			writer: {
				addUserMessage: (text: string) => userMessages.push(text),
				addAgentReply: (text: string) => agentReplies.push(text),
				addNotice: (text: string) => notices.push(text),
				addTokenFooter: () => ({ setText: () => {} }),
				addCompletedToolBlock: () => {},
				addBatchTiming: () => {},
				addSubagentReply: () => {},
				clearAll: () => {
					cleared += 1;
				},
			},
			addToHistory: (text: string) => history.push(text),
			addHistoryEntry: () => {},
			clearEditor: () => {},
			dispatch: (event: { type: string }) => dispatched.push(event),
			ctx: () => ({
				writer: {
					addNotice: (text: string) => notices.push(text),
				},
				tui: { requestRender: () => {} },
				session: {
					state: { contextWindow: 100_000 },
					setTurnController: () => {},
				},
				dispatch: (event: { type: string }) => dispatched.push(event),
			}),
			onThinkingStop: () => {},
		} as unknown as SubmitConfig,
		sent,
		notices,
		userMessages,
		agentReplies,
		getCleared: () => cleared,
		dispatched,
		history,
	};
}

describe("colon command submit interception", () => {
	it("':help' should not be sent as a prompt to the LLM", async () => {
		const { config, sent } = makeStubConfig();
		const handler = createSubmitHandler(config as never);

		await handler(":help");

		expect(sent, "Colon command was sent to LLM as a prompt").toHaveLength(0);
	});

	it("':theme' should dispatch to command registry, not LLM", async () => {
		const { config, sent } = makeStubConfig();
		const handler = createSubmitHandler(config as never);

		await handler(":theme dark");

		expect(sent, "Colon command was sent to LLM as a prompt").toHaveLength(0);
	});

	it("text not starting with ':' should still be sent as a prompt", async () => {
		const { config, sent } = makeStubConfig();
		const handler = createSubmitHandler(config as never);

		await handler("explain this function");

		expect(sent).toHaveLength(1);
		expect(sent[0]).toBe("explain this function");
	});

	it("'/help' (slash) should not be sent as a prompt", async () => {
		const { config, sent } = makeStubConfig();
		const handler = createSubmitHandler(config as never);

		await handler("/help");

		expect(sent, "Slash command was sent to LLM as a prompt").toHaveLength(0);
	});

	it("bare @topic switches the active discussion topic", async () => {
		const { config, notices, userMessages, agentReplies, getCleared } = makeStubConfig();
		let activeTopic = "root";
		config.forums = {
			switchTo: (name: string) => {
				activeTopic = name;
			},
			list: async () => ["root", "review"],
			getActive: () => activeTopic,
		};
		const handler = createSubmitHandler(config as never);

		await handler("@review");

		expect(activeTopic).toBe("review");
		expect(getCleared()).toBe(0);
		expect(userMessages).toEqual([]);
		expect(agentReplies).toEqual([]);
		expect(notices.at(-1)).toBe("Switched to topic @review");
	});
});
