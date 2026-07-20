import { describe, expect, it } from "vitest";
import { getModel } from "../src/models/llm.js";
import { complete, stream } from "../src/stream.js";
import type { Api, Context, Model, StreamOptions } from "../src/types.js";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

import { hasAzureOpenAICredentials, resolveAzureDeploymentName } from "./azure-utils.js";
import { hasBedrockCredentials } from "./bedrock-utils.js";
import { HAVE_REAL_LLM } from "./gate.js";
import { resolveApiKey } from "./oauth.js";
import { describeProviders, type ProviderCase } from "./provider-matrix.js";

// Resolve OAuth tokens at module level (async, runs before tests)
const [openaiCodexToken] = await Promise.all([resolveApiKey("openai-codex")]);

async function testAbortSignal<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const context: Context = {
		messages: [
			{
				role: "user",
				content: "What is 15 + 27? Think step by step. Then list 50 first names.",
				timestamp: Date.now(),
			},
		],
		systemPrompt: "You are a helpful assistant.",
	};

	let abortFired = false;
	let text = "";
	const controller = new AbortController();
	const response = await stream(llm, context, { ...options, signal: controller.signal });
	for await (const event of response) {
		if (abortFired) return;
		if (event.type === "text_delta" || event.type === "thinking_delta") {
			text += event.delta;
		}
		if (text.length >= 50) {
			controller.abort();
			abortFired = true;
		}
	}
	const msg = await response.result();

	// If we get here without throwing, the abort didn't work
	expect(msg.stopReason).toBe("aborted");
	expect(msg.content.length).toBeGreaterThan(0);

	context.messages.push(msg);
	context.messages.push({
		role: "user",
		content: "Please continue, but only generate 5 names.",
		timestamp: Date.now(),
	});

	const followUp = await complete(llm, context, options);
	expect(followUp.stopReason).toBe("stop");
	expect(followUp.content.length).toBeGreaterThan(0);
}

async function testImmediateAbort<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const controller = new AbortController();

	controller.abort();

	const context: Context = {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};

	const response = await complete(llm, context, { ...options, signal: controller.signal });
	expect(response.stopReason).toBe("aborted");
}

async function testAbortThenNewMessage<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	// First request: abort immediately before any response content arrives
	const controller = new AbortController();
	controller.abort();

	const context: Context = {
		messages: [{ role: "user", content: "Hello, how are you?", timestamp: Date.now() }],
	};

	const abortedResponse = await complete(llm, context, { ...options, signal: controller.signal });
	expect(abortedResponse.stopReason).toBe("aborted");
	// The aborted message has empty content since we aborted before anything arrived
	expect(abortedResponse.content.length).toBe(0);

	// Add the aborted assistant message to context (this is what happens in the real coding agent)
	context.messages.push(abortedResponse);

	// Second request: send a new message - this should work even with the aborted message in context
	context.messages.push({
		role: "user",
		content: "What is 2 + 2?",
		timestamp: Date.now(),
	});

	const followUp = await complete(llm, context, options);
	expect(followUp.stopReason).toBe("stop");
	expect(followUp.content.length).toBeGreaterThan(0);
}

const PROVIDERS: ProviderCase[] = [
	{
		name: "Google Provider Abort",
		hasCredentials: !!process.env.GEMINI_API_KEY,
		model: () => getModel("google", "gemini-2.5-flash"),
		options: { thinking: { enabled: true } },
	},
	{
		name: "OpenAI Completions Provider Abort",
		hasCredentials: !!process.env.OPENAI_API_KEY,
		model: () => {
			const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
			void _compat;
			return { ...baseModel, api: "openai-completions" } satisfies Model<"openai-completions">;
		},
	},
	{
		name: "OpenAI Responses Provider Abort",
		hasCredentials: !!process.env.OPENAI_API_KEY,
		model: () => getModel("openai", "gpt-5-mini"),
	},
	{
		name: "Azure OpenAI Responses Provider Abort",
		hasCredentials: hasAzureOpenAICredentials(),
		model: () => getModel("azure-openai-responses", "gpt-4o-mini"),
		options: (llm) => {
			const azureDeploymentName = resolveAzureDeploymentName(llm.id);
			return azureDeploymentName ? { azureDeploymentName } : {};
		},
	},
	{
		name: "Anthropic Provider Abort",
		hasCredentials: !!process.env.ANTHROPIC_OAUTH_TOKEN,
		model: () => getModel("anthropic", "claude-opus-4-1-20250805"),
		options: { thinkingEnabled: true, thinkingBudgetTokens: 2048 },
	},
	{
		name: "Mistral Provider Abort",
		hasCredentials: !!process.env.MISTRAL_API_KEY,
		model: () => getModel("mistral", "devstral-medium-latest"),
	},
	{
		name: "Together AI Provider Abort",
		hasCredentials: !!process.env.TOGETHER_API_KEY,
		model: () => getModel("together", "moonshotai/Kimi-K2.6"),
		options: { reasoningEffort: "high" },
	},
	{
		name: "MiniMax Provider Abort",
		hasCredentials: !!process.env.MINIMAX_API_KEY,
		model: () => getModel("minimax", "MiniMax-M2.7"),
	},
	{
		name: "Xiaomi MiMo (API billing) Provider Abort",
		hasCredentials: !!process.env.XIAOMI_API_KEY,
		model: () => getModel("xiaomi", "mimo-v2.5-pro"),
	},
	{
		name: "Xiaomi MiMo Token Plan (CN) Provider Abort",
		hasCredentials: !!process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY,
		model: () => getModel("xiaomi-token-plan-cn", "mimo-v2.5-pro"),
	},
	{
		name: "Xiaomi MiMo Token Plan (AMS) Provider Abort",
		hasCredentials: !!process.env.XIAOMI_TOKEN_PLAN_AMS_API_KEY,
		model: () => getModel("xiaomi-token-plan-ams", "mimo-v2.5-pro"),
	},
	{
		name: "Xiaomi MiMo Token Plan (SGP) Provider Abort",
		hasCredentials: !!process.env.XIAOMI_TOKEN_PLAN_SGP_API_KEY,
		model: () => getModel("xiaomi-token-plan-sgp", "mimo-v2.5-pro"),
	},
	{
		name: "Kimi For Coding Provider Abort",
		hasCredentials: !!process.env.KIMI_API_KEY,
		model: () => getModel("kimi-coding", "kimi-k2-thinking"),
	},
	{
		name: "Vercel AI Gateway Provider Abort",
		hasCredentials: !!process.env.AI_GATEWAY_API_KEY,
		model: () => getModel("vercel-ai-gateway", "google/gemini-2.5-flash"),
	},
	{
		name: "OpenAI Codex Provider Abort",
		hasCredentials: !!openaiCodexToken,
		model: () => getModel("openai-codex", "gpt-5.2-codex"),
		options: { apiKey: openaiCodexToken },
	},
	{
		name: "Amazon Bedrock Provider Abort",
		hasCredentials: hasBedrockCredentials(),
		model: () => getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0"),
	},
];

describeProviders(
	"AI Providers Abort Tests",
	PROVIDERS,
	[
		{
			title: "should abort mid-stream",
			run: async (_ctx, llm, options) => {
				// Bedrock's abort mid-stream needs a distinct reasoning option from its other scenarios.
				const abortOptions = llm.provider === "amazon-bedrock" ? { ...options, reasoning: "medium" } : options;
				await testAbortSignal(llm, abortOptions);
			},
		},
		{
			title: "should handle immediate abort",
			run: async (_ctx, llm, options) => {
				await testImmediateAbort(llm, options);
			},
		},
	],
	{ tags: ["real-llm"] },
);

// Amazon Bedrock is the only provider covered by this extra abort+continue scenario.
describe.skipIf(!HAVE_REAL_LLM || !hasBedrockCredentials())(
	"Amazon Bedrock Provider Abort — abort then new message",
	{ tags: ["real-llm"] },
	() => {
		it("should handle abort then new message", { retry: 3 }, async () => {
			const llm = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0")!;
			await testAbortThenNewMessage(llm);
		});
	},
);
