/**
 * Model switch must update the LLM adapter's getModel() — not only the footer.
 * Frozen `const currentModel = model` left the reasoner on the boot model
 * (e.g. Sonnet 200k) after `:model` / setModel to Opus 1M.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@dpopsuev/alef-ai/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionHandle } from "../src/boot/handle.js";

const previousState = process.env.XDG_STATE_HOME;

beforeEach(() => {
	process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "alef-model-switch-"));
});

afterEach(() => {
	if (previousState === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = previousState;
});

function stubModel(id: string, contextWindow: number): Model<Api> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 8192,
	} as Model<Api>;
}

describe("SessionHandle.setModel", { tags: ["unit"] }, () => {
	it("notifies onModelChange so LLM getModel() tracks the new context window", () => {
		const sonnet = stubModel("claude-sonnet-4-6", 200_000);
		const opus = stubModel("claude-opus-4-6", 1_000_000);
		let llmModel = sonnet;
		const getModel = () => llmModel;

		const handle = new SessionHandle({
			state: { id: "s", modelId: sonnet.id, contextWindow: sonnet.contextWindow },
			model: sonnet,
			thinkingState: { level: "medium" },
			controller: { receive: vi.fn(), send: vi.fn() } as never,
			agent: { dispose: vi.fn(), publishEvent: vi.fn(), load: vi.fn() } as never,
			directives: { register: vi.fn() } as never,
			args: {} as never,
			log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
			observers: new Set(),
			modelFactory: (id) => (id === opus.id ? opus : sonnet),
			discussion: {
				home: { forumId: "f", topicId: "t", topicTitle: "home" },
				active: { forumId: "f", topicId: "t", topicTitle: "home" },
				subscriptions: [],
			},
			discourseBackend: { append: vi.fn(async () => ({ id: "p" })) } as never,
			humanAddress: "human",
			agentAddress: "agent",
			onModelChange: (next) => {
				llmModel = next;
			},
		});

		expect(getModel().contextWindow).toBe(200_000);
		handle.setModel(opus.id);
		expect(handle.getModel()).toBe(opus.id);
		expect(handle.getModelObject().contextWindow).toBe(1_000_000);
		expect(getModel().id).toBe(opus.id);
		expect(getModel().contextWindow).toBe(1_000_000);
		expect(handle.state.contextWindow).toBe(1_000_000);
	});
});
