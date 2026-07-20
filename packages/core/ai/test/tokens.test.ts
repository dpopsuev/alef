import type { TestContext } from "vitest";
import { expect } from "vitest";
import { getModel } from "../src/models/llm.js";
import { stream } from "../src/stream.js";
import type { Api, Context, Model, StreamOptions } from "../src/types.js";

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

async function testTokensOnAbort<TApi extends Api>(
	ctx: TestContext,
	llm: Model<TApi>,
	options: StreamOptionsWithExtras = {},
) {
	const context: Context = {
		messages: [
			{
				role: "user",
				content: "Write a long poem with 20 stanzas about the beauty of nature.",
				timestamp: Date.now(),
			},
		],
		systemPrompt: "You are a helpful assistant.",
	};

	const controller = new AbortController();
	const capture = withStatusCapture(options);
	const response = stream(llm, context, { ...capture.options, signal: controller.signal });

	let abortFired = false;
	let text = "";
	for await (const event of response) {
		if (!abortFired && (event.type === "text_delta" || event.type === "thinking_delta")) {
			text += event.delta;
			if (text.length >= 1000) {
				abortFired = true;
				controller.abort();
			}
		}
	}

	const msg = await response.result();
	skipIfQuotaExceeded(ctx, capture.getStatus(), msg.errorMessage);

	expect(msg.stopReason).toBe("aborted");

	// OpenAI providers, OpenAI Codex, zai, and Amazon Bedrock only send usage in the final chunk,
	// so when aborted they have no token stats. Anthropic and Google send usage information early in the stream.
	// MiniMax and Kimi report input tokens but not output tokens differently on aborted requests.
	if (
		llm.api === "openai-completions" ||
		llm.api === "mistral-conversations" ||
		llm.api === "openai-responses" ||
		llm.api === "azure-openai-responses" ||
		llm.api === "openai-codex-responses" ||
		llm.provider === "zai" ||
		llm.provider === "amazon-bedrock" ||
		llm.provider === "vercel-ai-gateway"
	) {
		expect(msg.usage.input).toBe(0);
		expect(msg.usage.output).toBe(0);
	} else if (llm.provider === "minimax") {
		// MiniMax M2.7 does not report token usage for aborted requests.
		expect(msg.usage.input).toBe(0);
		expect(msg.usage.output).toBe(0);
	} else if (llm.provider === "kimi-coding") {
		// Kimi reports input tokens early but output tokens only in the final chunk.
		expect(msg.usage.input).toBeGreaterThan(0);
		expect(msg.usage.output).toBe(0);
	} else {
		expect(msg.usage.input).toBeGreaterThan(0);
		expect(msg.usage.output).toBeGreaterThan(0);

		// Some providers (Copilot) have zero cost rates
		if (llm.cost.input > 0) {
			expect(msg.usage.cost.input).toBeGreaterThan(0);
			expect(msg.usage.cost.total).toBeGreaterThan(0);
		}
	}
}

const XIAOMI_STREAMING_USAGE_FIXME =
	"Xiaomi's Anthropic-compatible stream does not populate usage in message_start the way Anthropic does — usage only arrives at message_stop, so aborting mid-stream loses input/output token counts. Non-streaming usage works (see total-tokens.test.ts). Re-enable once upstream sends usage in message_start.";

const PROVIDERS: ProviderCase[] = [
	{
		name: "Google Provider",
		hasCredentials: !!process.env.GEMINI_API_KEY,
		model: () => getModel("google", "gemini-2.5-flash"),
		options: { thinking: { enabled: true } },
	},
	{
		name: "OpenAI Completions Provider",
		hasCredentials: !!process.env.OPENAI_API_KEY,
		model: () => {
			const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
			void _compat;
			return { ...baseModel, api: "openai-completions" } satisfies Model<"openai-completions">;
		},
	},
	{
		name: "OpenAI Responses Provider",
		hasCredentials: !!process.env.OPENAI_API_KEY,
		model: () => getModel("openai", "gpt-5.4-mini"),
		options: { reasoningEffort: "low" },
	},
	{
		name: "Azure OpenAI Responses Provider",
		hasCredentials: hasAzureOpenAICredentials(),
		model: () => getModel("azure-openai-responses", "gpt-4o-mini"),
		options: (llm) => {
			const azureDeploymentName = resolveAzureDeploymentName(llm.id);
			return azureDeploymentName ? { azureDeploymentName } : {};
		},
	},
	{
		name: "Anthropic Provider",
		hasCredentials: !!process.env.ANTHROPIC_API_KEY,
		model: () => getModel("anthropic", "claude-sonnet-4-6"),
	},
	{
		name: "xAI Provider",
		hasCredentials: !!process.env.XAI_API_KEY,
		model: () => getModel("xai", "grok-code-fast-1"),
	},
	{
		name: "Groq Provider",
		hasCredentials: !!process.env.GROQ_API_KEY,
		model: () => getModel("groq", "openai/gpt-oss-20b"),
	},
	{
		name: "Cerebras Provider",
		hasCredentials: !!process.env.CEREBRAS_API_KEY,
		model: () => getModel("cerebras", "gpt-oss-120b"),
	},
	{
		name: "Cloudflare Workers AI Provider",
		hasCredentials: hasCloudflareWorkersAICredentials(),
		model: () => getModel("cloudflare-workers-ai", "@cf/moonshotai/kimi-k2.6"),
	},
	{
		name: "Cloudflare AI Gateway Provider",
		hasCredentials: hasCloudflareAiGatewayCredentials(),
		model: () => getModel("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.6"),
	},
	{
		name: "Hugging Face Provider",
		hasCredentials: !!process.env.HF_TOKEN,
		model: () => getModel("huggingface", "moonshotai/Kimi-K2.5"),
	},
	{
		name: "Together AI Provider",
		hasCredentials: !!process.env.TOGETHER_API_KEY,
		model: () => getModel("together", "moonshotai/Kimi-K2.6"),
	},
	{
		name: "zAI Provider",
		hasCredentials: !!process.env.ZAI_API_KEY,
		model: () => getModel("zai", "glm-4.5-air"),
	},
	{
		name: "Mistral Provider",
		hasCredentials: !!process.env.MISTRAL_API_KEY,
		model: () => getModel("mistral", "devstral-medium-latest"),
	},
	{
		name: "MiniMax Provider",
		hasCredentials: !!process.env.MINIMAX_API_KEY,
		model: () => getModel("minimax", "MiniMax-M2.7"),
	},
	{
		name: "Kimi For Coding Provider",
		hasCredentials: !!process.env.KIMI_API_KEY,
		model: () => getModel("kimi-coding", "kimi-for-coding"),
	},
	{
		name: "Vercel AI Gateway Provider",
		hasCredentials: !!process.env.AI_GATEWAY_API_KEY,
		model: () => getModel("vercel-ai-gateway", "google/gemini-2.5-flash"),
	},
	{
		name: "Xiaomi MiMo (API billing) Provider",
		hasCredentials: !!process.env.XIAOMI_API_KEY,
		model: () => getModel("xiaomi", "mimo-v2.5-pro"),
		skipReason: XIAOMI_STREAMING_USAGE_FIXME,
	},
	{
		name: "Xiaomi MiMo Token Plan (CN) Provider",
		hasCredentials: !!process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY,
		model: () => getModel("xiaomi-token-plan-cn", "mimo-v2.5-pro"),
		skipReason: XIAOMI_STREAMING_USAGE_FIXME,
	},
	{
		name: "Xiaomi MiMo Token Plan (AMS) Provider",
		hasCredentials: !!process.env.XIAOMI_TOKEN_PLAN_AMS_API_KEY,
		model: () => getModel("xiaomi-token-plan-ams", "mimo-v2.5-pro"),
		skipReason: XIAOMI_STREAMING_USAGE_FIXME,
	},
	{
		name: "Xiaomi MiMo Token Plan (SGP) Provider",
		hasCredentials: !!process.env.XIAOMI_TOKEN_PLAN_SGP_API_KEY,
		model: () => getModel("xiaomi-token-plan-sgp", "mimo-v2.5-pro"),
		skipReason: XIAOMI_STREAMING_USAGE_FIXME,
	},
	// =========================================================================
	// OAuth-based providers (credentials from Alef agent dir `oauth.json`)
	// =========================================================================
	{
		name: "Anthropic OAuth Provider",
		hasCredentials: !!anthropicOAuthToken,
		model: () => getModel("anthropic", "claude-sonnet-4-6"),
		options: { apiKey: anthropicOAuthToken },
	},
	{
		name: "GitHub Copilot Provider - gpt-4o",
		hasCredentials: !!githubCopilotToken,
		model: () => getModel("github-copilot", "gpt-5-mini"),
		options: { apiKey: githubCopilotToken },
	},
	{
		name: "GitHub Copilot Provider - claude-sonnet-4",
		hasCredentials: !!githubCopilotToken,
		model: () => getModel("github-copilot", "claude-sonnet-4.5"),
		options: { apiKey: githubCopilotToken },
	},
	{
		name: "OpenAI Codex Provider - gpt-5.2-codex",
		hasCredentials: !!openaiCodexToken,
		model: () => getModel("openai-codex", "gpt-5.2-codex"),
		options: { apiKey: openaiCodexToken },
	},
	{
		name: "Amazon Bedrock Provider",
		hasCredentials: hasBedrockCredentials(),
		model: () => getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0"),
	},
];

describeProviders("Token Statistics on Abort", PROVIDERS, [
	{
		title: "should include token stats when aborted mid-stream",
		run: async (ctx, llm, options) => {
			await testTokensOnAbort(ctx, llm, options);
		},
	},
]);
