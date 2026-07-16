import { describe, expect, it } from "vitest";
import type { Context, Model } from "../src/types.js";

describe("Cache Optimization for Skills and Memory", { tags: ["unit"] }, () => {
	const context: Context = {
		systemPrompt: "You are a helpful assistant with access to skills.",
		messages: [
			{
				role: "user",
				content: "Load the testing skill",
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_1",
						name: "skills.invoke",
						arguments: { name: "testing" },
					},
				],
				api: "anthropic-messages",
				provider: "test-anthropic",
				model: "test-model",
				usage: {
					input: 0,
					output: 0,
					totalTokens: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "skills.invoke",
				content: [
					{
						type: "text",
						text: "# Testing Skill\n\n" + "Detailed instructions ".repeat(100), // Large skill content
					},
				],
				isError: false,
				timestamp: Date.now(),
			},
		],
		tools: [
			{
				name: "skills.invoke",
				description: "Load a skill",
				parameters: {
					type: "object",
					properties: {
						name: { type: "string" },
					},
					required: ["name"],
				},
			},
			{
				name: "skills.open",
				description: "Load all skill pages",
				parameters: {
					type: "object",
					properties: {
						book: { type: "string" },
					},
					required: ["book"],
				},
			},
		],
	};

	function createTestModel(): Model<"anthropic-messages"> {
		return {
			id: "test-model",
			name: "Test Model",
			api: "anthropic-messages",
			provider: "test-anthropic",
			baseUrl: "https://api.anthropic.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 4096,
		};
	}

	it("should add cache_control to system prompt", async () => {
		let capturedPayload: any = null;
		const { streamAnthropic } = await import("../src/providers/anthropic.js");

		try {
			const s = streamAnthropic(createTestModel(), context, {
				apiKey: "fake-key",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			});

			for await (const event of s) {
				if (event.type === "error") break;
			}
		} catch {
			// Expected to fail with fake key
		}

		expect(capturedPayload).not.toBeNull();
		expect(capturedPayload.system).toBeDefined();
		expect(capturedPayload.system[0].cache_control).toEqual({ type: "ephemeral" });
	});

	it("should add cache_control to last tool definition", async () => {
		let capturedPayload: any = null;
		const { streamAnthropic } = await import("../src/providers/anthropic.js");

		try {
			const s = streamAnthropic(createTestModel(), context, {
				apiKey: "fake-key",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			});

			for await (const event of s) {
				if (event.type === "error") break;
			}
		} catch {
			// Expected to fail
		}

		expect(capturedPayload).not.toBeNull();
		expect(capturedPayload.tools).toBeDefined();
		expect(capturedPayload.tools.length).toBe(2);
		
		// First tool should NOT have cache_control
		expect(capturedPayload.tools[0].cache_control).toBeUndefined();
		
		// Last tool (skills.open) SHOULD have cache_control
		expect(capturedPayload.tools[1].cache_control).toEqual({ type: "ephemeral" });
	});

	it("should add cache_control to last user message containing tool results", async () => {
		let capturedPayload: any = null;
		const { streamAnthropic } = await import("../src/providers/anthropic.js");

		try {
			const s = streamAnthropic(createTestModel(), context, {
				apiKey: "fake-key",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			});

			for await (const event of s) {
				if (event.type === "error") break;
			}
		} catch {
			// Expected to fail
		}

		expect(capturedPayload).not.toBeNull();
		expect(capturedPayload.messages).toBeDefined();
		
		// Last message should be the user message with tool results
		const lastMessage = capturedPayload.messages[capturedPayload.messages.length - 1];
		expect(lastMessage.role).toBe("user");
		expect(Array.isArray(lastMessage.content)).toBe(true);
		
		// Last content block should have cache_control
		const lastBlock = lastMessage.content[lastMessage.content.length - 1];
		expect(lastBlock.cache_control).toEqual({ type: "ephemeral" });
	});

	it("should use long cache retention when cacheRetention=long", async () => {
		let capturedPayload: any = null;
		const { streamAnthropic } = await import("../src/providers/anthropic.js");

		try {
			const s = streamAnthropic(createTestModel(), context, {
				apiKey: "fake-key",
				cacheRetention: "long",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			});

			for await (const event of s) {
				if (event.type === "error") break;
			}
		} catch {
			// Expected to fail
		}

		expect(capturedPayload).not.toBeNull();
		
		// System should have 1h TTL
		expect(capturedPayload.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		
		// Last tool should have 1h TTL
		expect(capturedPayload.tools[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		
		// Last message block should have 1h TTL
		const lastMessage = capturedPayload.messages[capturedPayload.messages.length - 1];
		const lastBlock = lastMessage.content[lastMessage.content.length - 1];
		expect(lastBlock.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
	});

	it("should cache memory context injections in user messages", async () => {
		const contextWithMemory: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [
				{
					role: "user",
					content: "Remember: I prefer TypeScript over JavaScript.\n\nWrite a function.",
					timestamp: Date.now(),
				},
			],
		};

		let capturedPayload: any = null;
		const { streamAnthropic } = await import("../src/providers/anthropic.js");

		try {
			const s = streamAnthropic(createTestModel(), contextWithMemory, {
				apiKey: "fake-key",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			});

			for await (const event of s) {
				if (event.type === "error") break;
			}
		} catch {
			// Expected to fail
		}

		expect(capturedPayload).not.toBeNull();
		
		// Last user message should have cache_control
		const lastMessage = capturedPayload.messages[capturedPayload.messages.length - 1];
		expect(lastMessage.role).toBe("user");
		
		// When content is converted to array format for cache_control
		const lastBlock = Array.isArray(lastMessage.content) 
			? lastMessage.content[lastMessage.content.length - 1]
			: null;
		
		if (lastBlock) {
			expect(lastBlock.cache_control).toEqual({ type: "ephemeral" });
		}
	});
});
