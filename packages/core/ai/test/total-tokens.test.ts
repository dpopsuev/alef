/**
 * Test totalTokens field across all providers.
 *
 * totalTokens represents the total number of tokens processed by the LLM,
 * including input (with cache) and output (with thinking). This is the
 * base for calculating context size for the next request.
 *
 * - OpenAI Completions: Uses native total_tokens field
 * - OpenAI Responses: Uses native total_tokens field
 * - Google: Uses native totalTokenCount field
 * - Anthropic: Computed as input + output + cacheRead + cacheWrite
 * - Other OpenAI-compatible providers: Uses native total_tokens field
 */

import type { TestContext } from "vitest";
import { expect } from "vitest";
import { getModel } from "../src/models/llm.js";
import { complete } from "../src/stream.js";
import type { Api, Context, Model, StreamOptions, Usage } from "../src/types.js";

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

// Generate a long system prompt to trigger caching (>2k bytes for most providers)
const LONG_SYSTEM_PROMPT = `You are a helpful assistant. Be concise in your responses.

Here is some additional context that makes this system prompt long enough to trigger caching:

${Array(50)
	.fill(
		"Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.",
	)
	.join("\n\n")}

Remember: Always be helpful and concise.`;

async function testTotalTokensWithCache<TApi extends Api>(
	ctx: TestContext,
	llm: Model<TApi>,
	options: StreamOptionsWithExtras = {},
): Promise<{ first: Usage; second: Usage }> {
	// First request - no cache
	const context1: Context = {
		systemPrompt: LONG_SYSTEM_PROMPT,
		messages: [
			{
				role: "user",
				content: "What is 2 + 2? Reply with just the number.",
				timestamp: Date.now(),
			},
		],
	};

	const capture1 = withStatusCapture(options);
	const response1 = await complete(llm, context1, capture1.options);
	skipIfQuotaExceeded(ctx, capture1.getStatus(), response1.errorMessage);
	expect(response1.stopReason).toBe("stop");

	// Second request - should trigger cache read (same system prompt, add conversation)
	const context2: Context = {
		systemPrompt: LONG_SYSTEM_PROMPT,
		messages: [
			...context1.messages,
			response1, // Include previous assistant response
			{
				role: "user",
				content: "What is 3 + 3? Reply with just the number.",
				timestamp: Date.now(),
			},
		],
	};

	const capture2 = withStatusCapture(options);
	const response2 = await complete(llm, context2, capture2.options);
	skipIfQuotaExceeded(ctx, capture2.getStatus(), response2.errorMessage);
	expect(response2.stopReason).toBe("stop");

	if (llm.provider === "anthropic") {
		// Anthropic should have cache activity
		const hasCache = response2.usage.cacheRead > 0 || response2.usage.cacheWrite > 0 || response1.usage.cacheWrite > 0;
		expect(hasCache).toBe(true);
	}

	return { first: response1.usage, second: response2.usage };
}

function logUsage(label: string, usage: Usage) {
	const computed = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	console.log(`  ${label}:`);
	console.log(
		`    input: ${usage.input}, output: ${usage.output}, cacheRead: ${usage.cacheRead}, cacheWrite: ${usage.cacheWrite}`,
	);
	console.log(`    totalTokens: ${usage.totalTokens}, computed: ${computed}`);
}

function assertTotalTokensEqualsComponents(usage: Usage) {
	const computed = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	expect(usage.totalTokens).toBe(computed);
}

const PROVIDERS: ProviderCase[] = [
	{
		name: "Anthropic (API Key)",
		hasCredentials: !!process.env.ANTHROPIC_API_KEY,
		model: () => getModel("anthropic", "claude-sonnet-4-5"),
		options: { apiKey: process.env.ANTHROPIC_API_KEY },
	},
	{
		name: "Anthropic (OAuth)",
		hasCredentials: !!anthropicOAuthToken,
		model: () => getModel("anthropic", "claude-sonnet-4-6"),
		options: { apiKey: anthropicOAuthToken },
	},
	{
		name: "OpenAI Completions",
		hasCredentials: !!process.env.OPENAI_API_KEY,
		model: () => {
			const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!!;
			void _compat;
			return { ...baseModel, api: "openai-completions" } satisfies Model<"openai-completions">;
		},
	},
	{
		name: "OpenAI Responses",
		hasCredentials: !!process.env.OPENAI_API_KEY,
		model: () => getModel("openai", "gpt-5-mini"),
	},
	{
		name: "Azure OpenAI Responses",
		hasCredentials: hasAzureOpenAICredentials(),
		model: () => getModel("azure-openai-responses", "gpt-4o-mini"),
		options: (llm) => {
			const azureDeploymentName = resolveAzureDeploymentName(llm.id);
			return azureDeploymentName ? { azureDeploymentName } : {};
		},
	},
	{
		name: "Google",
		hasCredentials: !!process.env.GEMINI_API_KEY,
		model: () => getModel("google", "gemini-2.0-flash"),
	},
	{
		name: "xAI",
		hasCredentials: !!process.env.XAI_API_KEY,
		model: () => getModel("xai", "grok-code-fast-1"),
		options: { apiKey: process.env.XAI_API_KEY },
	},
	{
		name: "Groq",
		hasCredentials: !!process.env.GROQ_API_KEY,
		model: () => getModel("groq", "openai/gpt-oss-120b"),
		options: { apiKey: process.env.GROQ_API_KEY },
	},
	{
		name: "Cerebras",
		hasCredentials: !!process.env.CEREBRAS_API_KEY,
		model: () => getModel("cerebras", "gpt-oss-120b"),
		options: { apiKey: process.env.CEREBRAS_API_KEY },
	},
	{
		name: "Cloudflare Workers AI",
		hasCredentials: hasCloudflareWorkersAICredentials(),
		model: () => getModel("cloudflare-workers-ai", "@cf/moonshotai/kimi-k2.6"),
		options: { apiKey: process.env.CLOUDFLARE_API_KEY },
	},
	{
		name: "Cloudflare AI Gateway",
		hasCredentials: hasCloudflareAiGatewayCredentials(),
		model: () => getModel("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.6"),
		options: { apiKey: process.env.CLOUDFLARE_API_KEY },
	},
	{
		name: "Hugging Face",
		hasCredentials: !!process.env.HF_TOKEN,
		model: () => getModel("huggingface", "moonshotai/Kimi-K2.5"),
		options: { apiKey: process.env.HF_TOKEN },
	},
	{
		name: "Together AI",
		hasCredentials: !!process.env.TOGETHER_API_KEY,
		model: () => getModel("together", "moonshotai/Kimi-K2.6"),
		options: { apiKey: process.env.TOGETHER_API_KEY, reasoningEffort: "high" },
	},
	{
		name: "z.ai",
		hasCredentials: !!process.env.ZAI_API_KEY,
		model: () => getModel("zai", "glm-4.5-air"),
		options: { apiKey: process.env.ZAI_API_KEY },
	},
	{
		name: "Mistral",
		hasCredentials: !!process.env.MISTRAL_API_KEY,
		model: () => getModel("mistral", "devstral-medium-latest"),
		options: { apiKey: process.env.MISTRAL_API_KEY },
	},
	{
		name: "MiniMax",
		hasCredentials: !!process.env.MINIMAX_API_KEY,
		model: () => getModel("minimax", "MiniMax-M2.7"),
		options: { apiKey: process.env.MINIMAX_API_KEY },
	},
	{
		name: "Xiaomi MiMo (API billing)",
		hasCredentials: !!process.env.XIAOMI_API_KEY,
		model: () => getModel("xiaomi", "mimo-v2.5-pro"),
		options: { apiKey: process.env.XIAOMI_API_KEY },
	},
	{
		name: "Xiaomi MiMo Token Plan (CN)",
		hasCredentials: !!process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY,
		model: () => getModel("xiaomi-token-plan-cn", "mimo-v2.5-pro"),
		options: { apiKey: process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY },
	},
	{
		name: "Xiaomi MiMo Token Plan (AMS)",
		hasCredentials: !!process.env.XIAOMI_TOKEN_PLAN_AMS_API_KEY,
		model: () => getModel("xiaomi-token-plan-ams", "mimo-v2.5-pro"),
		options: { apiKey: process.env.XIAOMI_TOKEN_PLAN_AMS_API_KEY },
	},
	{
		name: "Xiaomi MiMo Token Plan (SGP)",
		hasCredentials: !!process.env.XIAOMI_TOKEN_PLAN_SGP_API_KEY,
		model: () => getModel("xiaomi-token-plan-sgp", "mimo-v2.5-pro"),
		options: { apiKey: process.env.XIAOMI_TOKEN_PLAN_SGP_API_KEY },
	},
	{
		name: "Kimi For Coding",
		hasCredentials: !!process.env.KIMI_API_KEY,
		model: () => getModel("kimi-coding", "kimi-k2-thinking"),
		options: { apiKey: process.env.KIMI_API_KEY },
	},
	{
		name: "Vercel AI Gateway",
		hasCredentials: !!process.env.AI_GATEWAY_API_KEY,
		model: () => getModel("vercel-ai-gateway", "google/gemini-2.5-flash"),
		options: { apiKey: process.env.AI_GATEWAY_API_KEY },
	},
	{
		name: "Amazon Bedrock",
		hasCredentials: hasBedrockCredentials(),
		model: () => getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0"),
	},
	// =========================================================================
	// OpenRouter — all models below use the ":free" catalog (cost: 0 in
	// llm.generated.ts) so opt-in ALEF_TEST_LLM=1 runs never bill an account.
	// =========================================================================
	{
		name: "OpenRouter (cohere/north-mini-code:free)",
		hasCredentials: !!process.env.OPENROUTER_API_KEY,
		model: () => getModel("openrouter", "cohere/north-mini-code:free"),
		options: { apiKey: process.env.OPENROUTER_API_KEY },
	},
	{
		name: "OpenRouter (poolside/laguna-m.1:free)",
		hasCredentials: !!process.env.OPENROUTER_API_KEY,
		model: () => getModel("openrouter", "poolside/laguna-m.1:free"),
		options: { apiKey: process.env.OPENROUTER_API_KEY },
	},
	{
		name: "OpenRouter (nvidia/nemotron-nano-9b-v2:free)",
		hasCredentials: !!process.env.OPENROUTER_API_KEY,
		model: () => getModel("openrouter", "nvidia/nemotron-nano-9b-v2:free"),
		options: { apiKey: process.env.OPENROUTER_API_KEY },
	},
	{
		name: "OpenRouter (nvidia/nemotron-3-super-120b-a12b:free)",
		hasCredentials: !!process.env.OPENROUTER_API_KEY,
		model: () => getModel("openrouter", "nvidia/nemotron-3-super-120b-a12b:free"),
		options: { apiKey: process.env.OPENROUTER_API_KEY },
	},
	{
		name: "OpenRouter (nvidia/nemotron-3-ultra-550b-a55b:free)",
		hasCredentials: !!process.env.OPENROUTER_API_KEY,
		model: () => getModel("openrouter", "nvidia/nemotron-3-ultra-550b-a55b:free"),
		options: { apiKey: process.env.OPENROUTER_API_KEY },
	},
	// =========================================================================
	// OAuth-based providers (credentials from Alef agent dir `oauth.json`)
	// =========================================================================
	{
		name: "GitHub Copilot (OAuth) - gpt-4o",
		hasCredentials: !!githubCopilotToken,
		model: () => getModel("github-copilot", "gpt-5-mini"),
		options: { apiKey: githubCopilotToken },
	},
	{
		name: "GitHub Copilot (OAuth) - claude-sonnet-4",
		hasCredentials: !!githubCopilotToken,
		model: () => getModel("github-copilot", "claude-sonnet-4.5"),
		options: { apiKey: githubCopilotToken },
	},
	{
		name: "OpenAI Codex (OAuth)",
		hasCredentials: !!openaiCodexToken,
		model: () => getModel("openai-codex", "gpt-5.2-codex"),
		options: { apiKey: openaiCodexToken },
	},
];

describeProviders("totalTokens field", PROVIDERS, [
	{
		title: "should return totalTokens equal to sum of components",
		run: async (ctx, llm, options) => {
			console.log(`\n${llm.provider} / ${llm.id}:`);
			const { first, second } = await testTotalTokensWithCache(ctx, llm, options);

			logUsage("First request", first);
			logUsage("Second request", second);

			assertTotalTokensEqualsComponents(first);
			assertTotalTokensEqualsComponents(second);
		},
	},
]);
