import { Type } from "typebox";
import type { TestContext } from "vitest";
import { expect } from "vitest";
import { getModel } from "../src/models/llm.js";
import { complete } from "../src/stream.js";
import type { Api, Context, Model, StreamOptions, ToolResultMessage } from "../src/types.js";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

import { skipIfQuotaExceeded, withStatusCapture } from "./api-status.js";
import { hasAzureOpenAICredentials, resolveAzureDeploymentName } from "./azure-utils.js";
import { hasBedrockCredentials } from "./bedrock-utils.js";
import { hasCloudflareAiGatewayCredentials, hasCloudflareWorkersAICredentials } from "./cloudflare-utils.js";
import { resolveApiKey } from "./oauth.js";
import { describeProviders, type ProviderCase } from "./provider-matrix.js";

// Empty schema for test tools - must be proper OBJECT type for Cloud Code Assist
const emptySchema = Type.Object({});

// Resolve OAuth tokens at module level (async, runs before tests)
const oauthTokens = await Promise.all([
	resolveApiKey("anthropic"),
	resolveApiKey("github-copilot"),
	resolveApiKey("openai-codex"),
]);
const [anthropicOAuthToken, githubCopilotToken, openaiCodexToken] = oauthTokens;

/**
 * Test for Unicode surrogate pair handling in tool results.
 *
 * Issue: When tool results contain emoji or other characters outside the Basic Multilingual Plane,
 * they may be incorrectly serialized as unpaired surrogates, causing "no low surrogate in string"
 * errors when sent to the API provider.
 *
 * Example error from Anthropic:
 * "The request body is not valid JSON: no low surrogate in string: line 1 column 197667"
 */

async function testEmojiInToolResults<TApi extends Api>(
	ctx: TestContext,
	llm: Model<TApi>,
	options: StreamOptionsWithExtras = {},
) {
	const toolCallId = llm.provider === "mistral" ? "testtool1" : "test_1";
	// Simulate a tool that returns emoji
	const context: Context = {
		systemPrompt: "You are a helpful assistant.",
		messages: [
			{
				role: "user",
				content: "Use the test tool",
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: toolCallId,
						name: "test_tool",
						arguments: {},
					},
				],
				api: llm.api,
				provider: llm.provider,
				model: llm.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		],
		tools: [
			{
				name: "test_tool",
				description: "A test tool",
				parameters: emptySchema,
			},
		],
	};

	// Add tool result with various problematic Unicode characters
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCallId,
		toolName: "test_tool",
		content: [
			{
				type: "text",
				text: `Test with emoji 🙈 and other characters:
- Monkey emoji: 🙈
- Thumbs up: 👍
- Heart: ❤️
- Thinking face: 🤔
- Rocket: 🚀
- Mixed text: Mario Zechner wann? Wo? Bin grad äußersr eventuninformiert 🙈
- Japanese: こんにちは
- Chinese: 你好
- Mathematical symbols: ∑∫∂√
- Special quotes: "curly" 'quotes'`,
			},
		],
		isError: false,
		timestamp: Date.now(),
	};

	context.messages.push(toolResult);

	// Add follow-up user message
	context.messages.push({
		role: "user",
		content: "Summarize the tool result briefly.",
		timestamp: Date.now(),
	});

	// This should not throw a surrogate pair error
	const capture = withStatusCapture(options);
	const response = await complete(llm, context, capture.options);
	skipIfQuotaExceeded(ctx, capture.getStatus(), response.errorMessage);

	expect(response.stopReason).not.toBe("error");
	expect(response.errorMessage).toBeFalsy();
	expect(response.content.length).toBeGreaterThan(0);
}

async function testRealWorldLinkedInData<TApi extends Api>(
	ctx: TestContext,
	llm: Model<TApi>,
	options: StreamOptionsWithExtras = {},
) {
	const toolCallId = llm.provider === "mistral" ? "linkedin1" : "linkedin_1";
	const context: Context = {
		systemPrompt: "You are a helpful assistant.",
		messages: [
			{
				role: "user",
				content: "Use the linkedin tool to get comments",
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: toolCallId,
						name: "linkedin_skill",
						arguments: {},
					},
				],
				api: llm.api,
				provider: llm.provider,
				model: llm.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		],
		tools: [
			{
				name: "linkedin_skill",
				description: "Get LinkedIn comments",
				parameters: emptySchema,
			},
		],
	};

	// Real-world tool result from LinkedIn with emoji
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCallId,
		toolName: "linkedin_skill",
		content: [
			{
				type: "text",
				text: `Post: Hab einen "Generative KI für Nicht-Techniker" Workshop gebaut.
Unanswered Comments: 2

=> {
  "comments": [
    {
      "author": "Matthias Neumayer's  graphic link",
      "text": "Leider nehmen das viel zu wenige Leute ernst"
    },
    {
      "author": "Matthias Neumayer's  graphic link",
      "text": "Mario Zechner wann? Wo? Bin grad äußersr eventuninformiert 🙈"
    }
  ]
}`,
			},
		],
		isError: false,
		timestamp: Date.now(),
	};

	context.messages.push(toolResult);

	context.messages.push({
		role: "user",
		content: "How many comments are there?",
		timestamp: Date.now(),
	});

	// This should not throw a surrogate pair error
	const capture = withStatusCapture(options);
	const response = await complete(llm, context, capture.options);
	skipIfQuotaExceeded(ctx, capture.getStatus(), response.errorMessage);

	expect(response.stopReason).not.toBe("error");
	expect(response.errorMessage).toBeFalsy();
	expect(response.content.some((b) => b.type === "text")).toBe(true);
}

async function testUnpairedHighSurrogate<TApi extends Api>(
	ctx: TestContext,
	llm: Model<TApi>,
	options: StreamOptionsWithExtras = {},
) {
	const toolCallId = llm.provider === "mistral" ? "testtool2" : "test_2";
	const context: Context = {
		systemPrompt: "You are a helpful assistant.",
		messages: [
			{
				role: "user",
				content: "Use the test tool",
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: toolCallId,
						name: "test_tool",
						arguments: {},
					},
				],
				api: llm.api,
				provider: llm.provider,
				model: llm.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		],
		tools: [
			{
				name: "test_tool",
				description: "A test tool",
				parameters: emptySchema,
			},
		],
	};

	// Construct a string with an intentionally unpaired high surrogate
	// This simulates what might happen if text processing corrupts emoji
	const unpairedSurrogate = String.fromCharCode(0xd83d); // High surrogate without low surrogate

	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCallId,
		toolName: "test_tool",
		content: [{ type: "text", text: `Text with unpaired surrogate: ${unpairedSurrogate} <- should be sanitized` }],
		isError: false,
		timestamp: Date.now(),
	};

	context.messages.push(toolResult);

	context.messages.push({
		role: "user",
		content: "What did the tool return?",
		timestamp: Date.now(),
	});

	// This should not throw a surrogate pair error
	// The unpaired surrogate should be sanitized before sending to API
	const capture = withStatusCapture(options);
	const response = await complete(llm, context, capture.options);
	skipIfQuotaExceeded(ctx, capture.getStatus(), response.errorMessage);

	expect(response.stopReason).not.toBe("error");
	expect(response.errorMessage).toBeFalsy();
	expect(response.content.length).toBeGreaterThan(0);
}


const PROVIDERS: ProviderCase[] = [
	{
		name: "Google Provider Unicode Handling",
		hasCredentials: !!process.env.GEMINI_API_KEY,
		model: () => getModel("google", "gemini-2.5-flash"),
	},
	{
		name: "OpenAI Completions Provider Unicode Handling",
		hasCredentials: !!process.env.OPENAI_API_KEY,
		model: () => getModel("openai", "gpt-4o-mini"),
	},
	{
		name: "OpenAI Responses Provider Unicode Handling",
		hasCredentials: !!process.env.OPENAI_API_KEY,
		model: () => getModel("openai", "gpt-5-mini"),
	},
	{
		name: "Azure OpenAI Responses Provider Unicode Handling",
		hasCredentials: hasAzureOpenAICredentials(),
		model: () => getModel("azure-openai-responses", "gpt-4o-mini"),
		options: (llm) => {
			const azureDeploymentName = resolveAzureDeploymentName(llm.id);
			return azureDeploymentName ? { azureDeploymentName } : {};
		},
	},
	{
		name: "Anthropic Provider Unicode Handling",
		hasCredentials: !!process.env.ANTHROPIC_API_KEY,
		model: () => getModel("anthropic", "claude-haiku-4-5"),
	},
	{
		name: "xAI Provider Unicode Handling",
		hasCredentials: !!process.env.XAI_API_KEY,
		model: () => getModel("xai", "grok-4.3"),
	},
	{
		name: "Groq Provider Unicode Handling",
		hasCredentials: !!process.env.GROQ_API_KEY,
		model: () => getModel("groq", "openai/gpt-oss-20b"),
	},
	{
		name: "Cerebras Provider Unicode Handling",
		hasCredentials: !!process.env.CEREBRAS_API_KEY,
		model: () => getModel("cerebras", "gpt-oss-120b"),
	},
	{
		name: "Cloudflare Workers AI Provider Unicode Handling",
		hasCredentials: hasCloudflareWorkersAICredentials(),
		model: () => getModel("cloudflare-workers-ai", "@cf/moonshotai/kimi-k2.6"),
	},
	{
		name: "Cloudflare AI Gateway Provider Unicode Handling",
		hasCredentials: hasCloudflareAiGatewayCredentials(),
		model: () => getModel("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.6"),
	},
	{
		name: "Hugging Face Provider Unicode Handling",
		hasCredentials: !!process.env.HF_TOKEN,
		model: () => getModel("huggingface", "moonshotai/Kimi-K2.5"),
	},
	{
		name: "Together AI Provider Unicode Handling",
		hasCredentials: !!process.env.TOGETHER_API_KEY,
		model: () => getModel("together", "moonshotai/Kimi-K2.6"),
		options: { reasoningEffort: "high" },
	},
	{
		name: "zAI Provider Unicode Handling",
		hasCredentials: !!process.env.ZAI_API_KEY,
		model: () => getModel("zai", "glm-4.5-air"),
	},
	{
		name: "Mistral Provider Unicode Handling",
		hasCredentials: !!process.env.MISTRAL_API_KEY,
		model: () => getModel("mistral", "devstral-medium-latest"),
	},
	{
		name: "MiniMax Provider Unicode Handling",
		hasCredentials: !!process.env.MINIMAX_API_KEY,
		model: () => getModel("minimax", "MiniMax-M2.7"),
	},
	{
		name: "Xiaomi MiMo (API billing) Provider Unicode Handling",
		hasCredentials: !!process.env.XIAOMI_API_KEY,
		model: () => getModel("xiaomi", "mimo-v2.5-pro"),
	},
	{
		name: "Xiaomi MiMo Token Plan (CN) Provider Unicode Handling",
		hasCredentials: !!process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY,
		model: () => getModel("xiaomi-token-plan-cn", "mimo-v2.5-pro"),
	},
	{
		name: "Xiaomi MiMo Token Plan (AMS) Provider Unicode Handling",
		hasCredentials: !!process.env.XIAOMI_TOKEN_PLAN_AMS_API_KEY,
		model: () => getModel("xiaomi-token-plan-ams", "mimo-v2.5-pro"),
	},
	{
		name: "Xiaomi MiMo Token Plan (SGP) Provider Unicode Handling",
		hasCredentials: !!process.env.XIAOMI_TOKEN_PLAN_SGP_API_KEY,
		model: () => getModel("xiaomi-token-plan-sgp", "mimo-v2.5-pro"),
	},
	{
		name: "Kimi For Coding Provider Unicode Handling",
		hasCredentials: !!process.env.KIMI_API_KEY,
		model: () => getModel("kimi-coding", "kimi-k2-thinking"),
	},
	{
		name: "Vercel AI Gateway Provider Unicode Handling",
		hasCredentials: !!process.env.AI_GATEWAY_API_KEY,
		model: () => getModel("vercel-ai-gateway", "google/gemini-2.5-flash"),
	},
	{
		name: "Amazon Bedrock Provider Unicode Handling",
		hasCredentials: hasBedrockCredentials(),
		model: () => getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0"),
	},
	// =========================================================================
	// OAuth-based providers (credentials from Alef agent dir `oauth.json`)
	// =========================================================================
	{
		name: "Anthropic OAuth Provider Unicode Handling",
		hasCredentials: !!anthropicOAuthToken,
		model: () => getModel("anthropic", "claude-haiku-4-5"),
		options: { apiKey: anthropicOAuthToken },
	},
	{
		name: "GitHub Copilot Provider Unicode Handling - gpt-4o",
		hasCredentials: !!githubCopilotToken,
		model: () => getModel("github-copilot", "gpt-5-mini"),
		options: { apiKey: githubCopilotToken },
	},
	{
		name: "GitHub Copilot Provider Unicode Handling - claude-sonnet-4",
		hasCredentials: !!githubCopilotToken,
		model: () => getModel("github-copilot", "claude-sonnet-4.5"),
		options: { apiKey: githubCopilotToken },
	},
	{
		name: "OpenAI Codex Provider Unicode Handling",
		hasCredentials: !!openaiCodexToken,
		model: () => getModel("openai-codex", "gpt-5.2-codex"),
		options: { apiKey: openaiCodexToken },
	},
];

describeProviders("AI Providers Unicode Surrogate Pair Tests", PROVIDERS, [
	{
		title: "should handle emoji in tool results",
		run: async (ctx, llm, options) => {
			await testEmojiInToolResults(ctx, llm, options);
		},
	},
	{
		title: "should handle real-world LinkedIn comment data with emoji",
		run: async (ctx, llm, options) => {
			await testRealWorldLinkedInData(ctx, llm, options);
		},
	},
	{
		title: "should handle unpaired high surrogate (0xD83D) in tool results",
		run: async (ctx, llm, options) => {
			await testUnpairedHighSurrogate(ctx, llm, options);
		},
	},
]);
