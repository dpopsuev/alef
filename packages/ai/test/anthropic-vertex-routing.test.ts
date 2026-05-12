import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
	anthropicConstructorCalls: [] as Array<Record<string, unknown>>,
	vertexConstructorCalls: [] as Array<Record<string, unknown>>,
	vertexCreateCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@anthropic-ai/sdk", () => {
	class FakeAnthropic {
		constructor(options: Record<string, unknown>) {
			mockState.anthropicConstructorCalls.push(options);
			throw new Error("unexpected direct anthropic client");
		}
	}

	return { default: FakeAnthropic };
});

vi.mock("@anthropic-ai/vertex-sdk", () => {
	function createSseResponse(): Response {
		const body = [
			`event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_vertex_test",
					usage: { input_tokens: 5, output_tokens: 0 },
				},
			})}\n`,
			`event: content_block_start\ndata: ${JSON.stringify({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			})}\n`,
			`event: content_block_delta\ndata: ${JSON.stringify({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "pong" },
			})}\n`,
			`event: content_block_stop\ndata: ${JSON.stringify({
				type: "content_block_stop",
				index: 0,
			})}\n`,
			`event: message_delta\ndata: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 4 },
			})}\n`,
			`event: message_stop\ndata: ${JSON.stringify({
				type: "message_stop",
			})}\n`,
		].join("\n");

		return new Response(body, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}

	class FakeAnthropicVertex {
		constructor(options: Record<string, unknown>) {
			mockState.vertexConstructorCalls.push(options);
		}

		messages = {
			create: (params: Record<string, unknown>) => {
				mockState.vertexCreateCalls.push(params);
				return {
					asResponse: async () => createSseResponse(),
				};
			},
		};
	}

	return { AnthropicVertex: FakeAnthropicVertex };
});

import { getModel } from "../src/models.js";
import { streamSimple } from "../src/stream.js";
import type { Context } from "../src/types.js";

function createContext(): Context {
	return {
		messages: [{ role: "user", content: "Reply with pong", timestamp: Date.now() }],
	};
}

describe("Anthropic Vertex routing", () => {
	beforeEach(() => {
		mockState.anthropicConstructorCalls.length = 0;
		mockState.vertexConstructorCalls.length = 0;
		mockState.vertexCreateCalls.length = 0;
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("prefers Vertex over direct Anthropic auth when Google Cloud project and location are configured", async () => {
		vi.stubEnv("ANTHROPIC_VERTEX_PROJECT_ID", "");
		vi.stubEnv("CLOUD_ML_REGION", "");
		vi.stubEnv("GOOGLE_CLOUD_PROJECT", "vertex-project");
		vi.stubEnv("GOOGLE_CLOUD_LOCATION", "global");
		vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api-key-test");

		const model = getModel("anthropic", "claude-sonnet-4-6");
		const result = await streamSimple(model, createContext(), {
			apiKey: "sk-ant-oat01-test",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "pong" }]);
		expect(mockState.vertexConstructorCalls).toEqual([{ projectId: "vertex-project", region: "global" }]);
		expect(mockState.vertexCreateCalls).toHaveLength(1);
		expect(mockState.vertexCreateCalls[0]).toMatchObject({
			model: "claude-sonnet-4-6",
			stream: true,
		});
		expect(mockState.anthropicConstructorCalls).toHaveLength(0);
	});

	it("prefers ANTHROPIC_VERTEX_PROJECT_ID over GOOGLE_CLOUD_PROJECT when both are set", async () => {
		vi.stubEnv("ANTHROPIC_VERTEX_PROJECT_ID", "vertex-override-project");
		vi.stubEnv("GOOGLE_CLOUD_PROJECT", "vertex-fallback-project");
		vi.stubEnv("CLOUD_ML_REGION", "global");

		const model = getModel("anthropic", "claude-sonnet-4-6");
		const result = await streamSimple(model, createContext()).result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(mockState.vertexConstructorCalls).toEqual([{ projectId: "vertex-override-project", region: "global" }]);
		expect(mockState.anthropicConstructorCalls).toHaveLength(0);
	});
});
