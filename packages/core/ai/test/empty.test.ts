import type { TestContext } from "vitest";
import { expect } from "vitest";
import { getModel } from "../src/models/llm.js";
import { complete } from "../src/stream.js";
import type { Api, AssistantMessage, Context, Model, StreamOptions, UserMessage } from "../src/types.js";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

import { skipIfQuotaExceeded, withStatusCapture } from "./api-status.js";
import { hasAzureOpenAICredentials, resolveAzureDeploymentName } from "./azure-utils.js";
import { hasBedrockCredentials } from "./bedrock-utils.js";
import { hasCloudflareAiGatewayCredentials, hasCloudflareWorkersAICredentials } from "./cloudflare-utils.js";
import { resolveApiKey } from "./oauth.js";
import { describeProviders, type ProviderCase } from "./provider-matrix.js";

// Resolve OAuth tokens at module level (async, runs before tests)
const oauthTokens = await Promise.all([
	resolveApiKey("anthropic"),
	resolveApiKey("github-copilot"),
	resolveApiKey("openai-codex"),
]);
const [anthropicOAuthToken, githubCopilotToken, openaiCodexToken] = oauthTokens;

async function testEmptyMessage<TApi extends Api>(
	ctx: TestContext,
	llm: Model<TApi>,
	options: StreamOptionsWithExtras = {},
) {
	// Test with completely empty content array
	const emptyMessage: UserMessage = {
		role: "user",
		content: [],
		timestamp: Date.now(),
	};

	const context: Context = {
		messages: [emptyMessage],
	};

	const capture = withStatusCapture(options);
	const response = await complete(llm, context, capture.options);
	skipIfQuotaExceeded(ctx, capture.getStatus(), response.errorMessage);

	// Should either handle gracefully or return an error
	expect(response).toBeDefined();
	expect(response.role).toBe("assistant");
	// Should handle empty string gracefully
	if (response.stopReason === "error") {
		expect(response.errorMessage).toBeDefined();
	} else {
		expect(response.content).toBeDefined();
	}
}

async function testEmptyStringMessage<TApi extends Api>(
	ctx: TestContext,
	llm: Model<TApi>,
	options: StreamOptionsWithExtras = {},
) {
	// Test with empty string content
	const context: Context = {
		messages: [
			{
				role: "user",
				content: "",
				timestamp: Date.now(),
			},
		],
	};

	const capture = withStatusCapture(options);
	const response = await complete(llm, context, capture.options);
	skipIfQuotaExceeded(ctx, capture.getStatus(), response.errorMessage);

	expect(response).toBeDefined();
	expect(response.role).toBe("assistant");

	// Should handle empty string gracefully
	if (response.stopReason === "error") {
		expect(response.errorMessage).toBeDefined();
	} else {
		expect(response.content).toBeDefined();
	}
}

async function testWhitespaceOnlyMessage<TApi extends Api>(
	ctx: TestContext,
	llm: Model<TApi>,
	options: StreamOptionsWithExtras = {},
) {
	// Test with whitespace-only content
	const context: Context = {
		messages: [
			{
				role: "user",
				content: "   \n\t  ",
				timestamp: Date.now(),
			},
		],
	};

	const capture = withStatusCapture(options);
	const response = await complete(llm, context, capture.options);
	skipIfQuotaExceeded(ctx, capture.getStatus(), response.errorMessage);

	expect(response).toBeDefined();
	expect(response.role).toBe("assistant");

	// Should handle whitespace-only gracefully
	if (response.stopReason === "error") {
		expect(response.errorMessage).toBeDefined();
	} else {
		expect(response.content).toBeDefined();
	}
}

async function testEmptyAssistantMessage<TApi extends Api>(
	ctx: TestContext,
	llm: Model<TApi>,
	options: StreamOptionsWithExtras = {},
) {
	// Test with empty assistant message in conversation flow
	// User -> Empty Assistant -> User
	const emptyAssistant: AssistantMessage = {
		role: "assistant",
		content: [],
		api: llm.api,
		provider: llm.provider,
		model: llm.id,
		usage: {
			input: 10,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	const context: Context = {
		messages: [
			{
				role: "user",
				content: "Hello, how are you?",
				timestamp: Date.now(),
			},
			emptyAssistant,
			{
				role: "user",
				content: "Please respond this time.",
				timestamp: Date.now(),
			},
		],
	};

	const capture = withStatusCapture(options);
	const response = await complete(llm, context, capture.options);
	skipIfQuotaExceeded(ctx, capture.getStatus(), response.errorMessage);

	expect(response).toBeDefined();
	expect(response.role).toBe("assistant");

	// Should handle empty assistant message in context gracefully
	if (response.stopReason === "error") {
		expect(response.errorMessage).toBeDefined();
	} else {
		expect(response.content).toBeDefined();
		expect(response.content.length).toBeGreaterThan(0);
	}
}

const PROVIDERS: ProviderCase[] = [
	{
		name: "Google Provider Empty Messages",
		hasCredentials: !!process.env.GEMINI_API_KEY,
		model: () => getModel("google", "gemini-2.5-flash"),
	},
	{
		name: "OpenAI Completions Provider Empty Messages",
		hasCredentials: !!process.env.OPENAI_API_KEY,
		model: () => getModel("openai", "gpt-4o-mini"),
	},
	{
		name: "OpenAI Responses Provider Empty Messages",
		hasCredentials: !!process.env.OPENAI_API_KEY,
		model: () => getModel("openai", "gpt-5-mini"),
	},
	{
		name: "Azure OpenAI Responses Provider Empty Messages",
		hasCredentials: hasAzureOpenAICredentials(),
		model: () => getModel("azure-openai-responses", "gpt-4o-mini"),
		options: (llm) => {
			const azureDeploymentName = resolveAzureDeploymentName(llm.id);
			return azureDeploymentName ? { azureDeploymentName } : {};
		},
	},
	{
		name: "Anthropic Provider Empty Messages",
		hasCredentials: !!process.env.ANTHROPIC_API_KEY,
		model: () => getModel("anthropic", "claude-haiku-4-5"),
	},
	{
		name: "xAI Provider Empty Messages",
		hasCredentials: !!process.env.XAI_API_KEY,
		model: () => getModel("xai", "grok-4.3"),
	},
	{
		name: "Groq Provider Empty Messages",
		hasCredentials: !!process.env.GROQ_API_KEY,
		model: () => getModel("groq", "openai/gpt-oss-20b"),
	},
	{
		name: "Cerebras Provider Empty Messages",
		hasCredentials: !!process.env.CEREBRAS_API_KEY,
		model: () => getModel("cerebras", "gpt-oss-120b"),
	},
	{
		name: "Cloudflare Workers AI Provider Empty Messages",
		hasCredentials: hasCloudflareWorkersAICredentials(),
		model: () => getModel("cloudflare-workers-ai", "@cf/moonshotai/kimi-k2.6"),
	},
	{
		name: "Cloudflare AI Gateway Provider Empty Messages",
		hasCredentials: hasCloudflareAiGatewayCredentials(),
		model: () => getModel("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.6"),
	},
	{
		name: "Hugging Face Provider Empty Messages",
		hasCredentials: !!process.env.HF_TOKEN,
		model: () => getModel("huggingface", "moonshotai/Kimi-K2.5"),
	},
	{
		name: "Together AI Provider Empty Messages",
		hasCredentials: !!process.env.TOGETHER_API_KEY,
		model: () => getModel("together", "moonshotai/Kimi-K2.6"),
	},
	{
		name: "zAI Provider Empty Messages",
		hasCredentials: !!process.env.ZAI_API_KEY,
		model: () => getModel("zai", "glm-4.5-air"),
	},
	{
		name: "Mistral Provider Empty Messages",
		hasCredentials: !!process.env.MISTRAL_API_KEY,
		model: () => getModel("mistral", "devstral-medium-latest"),
	},
	{
		name: "MiniMax Provider Empty Messages",
		hasCredentials: !!process.env.MINIMAX_API_KEY,
		model: () => getModel("minimax", "MiniMax-M2.7"),
	},
	{
		name: "Xiaomi MiMo (API billing) Provider Empty Messages",
		hasCredentials: !!process.env.XIAOMI_API_KEY,
		model: () => getModel("xiaomi", "mimo-v2.5-pro"),
	},
	{
		name: "Xiaomi MiMo Token Plan (CN) Provider Empty Messages",
		hasCredentials: !!process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY,
		model: () => getModel("xiaomi-token-plan-cn", "mimo-v2.5-pro"),
	},
	{
		name: "Xiaomi MiMo Token Plan (AMS) Provider Empty Messages",
		hasCredentials: !!process.env.XIAOMI_TOKEN_PLAN_AMS_API_KEY,
		model: () => getModel("xiaomi-token-plan-ams", "mimo-v2.5-pro"),
	},
	{
		name: "Xiaomi MiMo Token Plan (SGP) Provider Empty Messages",
		hasCredentials: !!process.env.XIAOMI_TOKEN_PLAN_SGP_API_KEY,
		model: () => getModel("xiaomi-token-plan-sgp", "mimo-v2.5-pro"),
	},
	{
		name: "Kimi For Coding Provider Empty Messages",
		hasCredentials: !!process.env.KIMI_API_KEY,
		model: () => getModel("kimi-coding", "kimi-k2-thinking"),
	},
	{
		name: "Vercel AI Gateway Provider Empty Messages",
		hasCredentials: !!process.env.AI_GATEWAY_API_KEY,
		model: () => getModel("vercel-ai-gateway", "google/gemini-2.5-flash"),
	},
	{
		name: "Amazon Bedrock Provider Empty Messages",
		hasCredentials: hasBedrockCredentials(),
		model: () => getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0"),
	},
	// =========================================================================
	// OAuth-based providers (credentials from Alef agent dir `oauth.json`)
	// =========================================================================
	{
		name: "Anthropic OAuth Provider Empty Messages",
		hasCredentials: !!anthropicOAuthToken,
		model: () => getModel("anthropic", "claude-haiku-4-5"),
		options: { apiKey: anthropicOAuthToken },
	},
	{
		name: "GitHub Copilot Provider Empty Messages - gpt-4o",
		hasCredentials: !!githubCopilotToken,
		model: () => getModel("github-copilot", "gpt-5-mini"),
		options: { apiKey: githubCopilotToken },
	},
	{
		name: "GitHub Copilot Provider Empty Messages - claude-sonnet-4",
		hasCredentials: !!githubCopilotToken,
		model: () => getModel("github-copilot", "claude-sonnet-4.5"),
		options: { apiKey: githubCopilotToken },
	},
	{
		name: "OpenAI Codex Provider Empty Messages - gpt-5.2-codex",
		hasCredentials: !!openaiCodexToken,
		model: () => getModel("openai-codex", "gpt-5.2-codex"),
		options: { apiKey: openaiCodexToken },
	},
];

describeProviders(
	"AI Providers Empty Message Tests",
	PROVIDERS,
	[
		{
			title: "should handle empty content array",
			run: async (ctx, llm, options) => {
				await testEmptyMessage(ctx, llm, options);
			},
		},
		{
			title: "should handle empty string content",
			run: async (ctx, llm, options) => {
				await testEmptyStringMessage(ctx, llm, options);
			},
		},
		{
			title: "should handle whitespace-only content",
			run: async (ctx, llm, options) => {
				await testWhitespaceOnlyMessage(ctx, llm, options);
			},
		},
		{
			title: "should handle empty assistant message in conversation",
			run: async (ctx, llm, options) => {
				await testEmptyAssistantMessage(ctx, llm, options);
			},
		},
	],
	{ tags: ["unit"] },
);
