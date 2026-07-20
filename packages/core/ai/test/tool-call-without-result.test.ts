import { Type } from "typebox";
import type { TestContext } from "vitest";
import { expect } from "vitest";
import { getModel } from "../src/models/llm.js";
import { complete } from "../src/stream.js";
import type { Api, Context, Model, StreamOptions, Tool } from "../src/types.js";

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

// Simple calculate tool
const calculateSchema = Type.Object({
	expression: Type.String({ description: "The mathematical expression to evaluate" }),
});

const calculateTool: Tool = {
	name: "calculate",
	description: "Evaluate mathematical expressions",
	parameters: calculateSchema,
};

async function testToolCallWithoutResult<TApi extends Api>(
	ctx: TestContext,
	model: Model<TApi>,
	options: StreamOptionsWithExtras = {},
) {
	// Step 1: Create context with the calculate tool
	const context: Context = {
		systemPrompt: "You are a helpful assistant. Use the calculate tool when asked to perform calculations.",
		messages: [],
		tools: [calculateTool],
	};

	// Step 2: Ask the LLM to make a tool call
	context.messages.push({
		role: "user",
		content: "Please calculate 25 * 18 using the calculate tool.",
		timestamp: Date.now(),
	});

	// Step 3: Get the assistant's response (should contain a tool call)
	const capture1 = withStatusCapture(options);
	const firstResponse = await complete(model, context, capture1.options);
	skipIfQuotaExceeded(ctx, capture1.getStatus(), firstResponse.errorMessage);
	context.messages.push(firstResponse);

	console.log("First response:", JSON.stringify(firstResponse, null, 2));

	// Verify the response contains a tool call
	const hasToolCall = firstResponse.content.some((block) => block.type === "toolCall");
	expect(hasToolCall).toBe(true);

	if (!hasToolCall) {
		throw new Error("Expected assistant to make a tool call, but none was found");
	}

	// Step 4: Send a user message WITHOUT providing tool result
	// This simulates the scenario where a tool call was aborted/cancelled
	context.messages.push({
		role: "user",
		content: "Never mind, just tell me what is 2+2?",
		timestamp: Date.now(),
	});

	// Step 5: The fix should filter out the orphaned tool call, and the request should succeed
	const capture2 = withStatusCapture(options);
	const secondResponse = await complete(model, context, capture2.options);
	skipIfQuotaExceeded(ctx, capture2.getStatus(), secondResponse.errorMessage);
	console.log("Second response:", JSON.stringify(secondResponse, null, 2));

	// The request should succeed (not error) - that's the main thing we're testing
	expect(secondResponse.stopReason).not.toBe("error");

	// Should have some content in the response
	expect(secondResponse.content.length).toBeGreaterThan(0);

	// The LLM may choose to answer directly or make a new tool call - either is fine
	// The important thing is it didn't fail with the orphaned tool call error
	const textContent = secondResponse.content
		.filter((block) => block.type === "text")
		.map((block) => (block.type === "text" ? block.text : ""))
		.join(" ");
	const toolCalls = secondResponse.content.filter((block) => block.type === "toolCall").length;
	expect(toolCalls || textContent.length).toBeGreaterThan(0);
	console.log("Answer:", textContent);

	// Verify the stop reason is either "stop" or "toolUse" (new tool call)
	expect(["stop", "toolUse"]).toContain(secondResponse.stopReason);
}

const PROVIDERS: ProviderCase[] = [
	{
		name: "Google Provider",
		hasCredentials: !!process.env.GEMINI_API_KEY,
		model: () => getModel("google", "gemini-2.5-flash"),
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
		model: () => getModel("openai", "gpt-5-mini"),
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
		model: () => getModel("anthropic", "claude-haiku-4-5"),
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
		options: { reasoningEffort: "high" },
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
		name: "Xiaomi MiMo (API billing) Provider",
		hasCredentials: !!process.env.XIAOMI_API_KEY,
		model: () => getModel("xiaomi", "mimo-v2.5-pro"),
	},
	{
		name: "Xiaomi MiMo Token Plan (CN) Provider",
		hasCredentials: !!process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY,
		model: () => getModel("xiaomi-token-plan-cn", "mimo-v2.5-pro"),
	},
	{
		name: "Xiaomi MiMo Token Plan (AMS) Provider",
		hasCredentials: !!process.env.XIAOMI_TOKEN_PLAN_AMS_API_KEY,
		model: () => getModel("xiaomi-token-plan-ams", "mimo-v2.5-pro"),
	},
	{
		name: "Xiaomi MiMo Token Plan (SGP) Provider",
		hasCredentials: !!process.env.XIAOMI_TOKEN_PLAN_SGP_API_KEY,
		model: () => getModel("xiaomi-token-plan-sgp", "mimo-v2.5-pro"),
	},
	{
		name: "Kimi For Coding Provider",
		hasCredentials: !!process.env.KIMI_API_KEY,
		model: () => getModel("kimi-coding", "kimi-k2-thinking"),
	},
	{
		name: "Vercel AI Gateway Provider",
		hasCredentials: !!process.env.AI_GATEWAY_API_KEY,
		model: () => getModel("vercel-ai-gateway", "google/gemini-2.5-flash"),
	},
	{
		name: "Amazon Bedrock Provider",
		hasCredentials: hasBedrockCredentials(),
		model: () => getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0"),
	},
	// =========================================================================
	// OAuth-based providers (credentials from Alef agent dir `oauth.json`)
	// =========================================================================
	{
		name: "Anthropic OAuth Provider",
		hasCredentials: !!anthropicOAuthToken,
		model: () => getModel("anthropic", "claude-haiku-4-5"),
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
];

describeProviders("Tool Call Without Result Tests", PROVIDERS, [
	{
		title: "should filter out tool calls without corresponding tool results",
		run: async (ctx, llm, options) => {
			await testToolCallWithoutResult(ctx, llm, options);
		},
	},
]);
