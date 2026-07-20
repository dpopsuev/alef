import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { expect } from "vitest";
import { getModel } from "../src/models/llm.js";
import { complete } from "../src/stream.js";
import type { Api, Context, Model, StreamOptions, Tool, ToolResultMessage } from "../src/types.js";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

import { hasAzureOpenAICredentials, resolveAzureDeploymentName } from "./azure-utils.js";
import { hasBedrockCredentials } from "./bedrock-utils.js";
import { resolveApiKey } from "./oauth.js";
import { describeProviders, type ProviderCase } from "./provider-matrix.js";

// Resolve OAuth tokens at module level (async, runs before tests)
const oauthTokens = await Promise.all([
	resolveApiKey("anthropic"),
	resolveApiKey("github-copilot"),
	resolveApiKey("openai-codex"),
]);
const [anthropicOAuthToken, githubCopilotToken, openaiCodexToken] = oauthTokens;

/**
 * Test that tool results containing only images work correctly across all providers.
 * This verifies that:
 * 1. Tool results can contain image content blocks
 * 2. Providers correctly pass images from tool results to the LLM
 * 3. The LLM can see and describe images returned by tools
 */
async function handleToolWithImageResult<TApi extends Api>(model: Model<TApi>, options?: StreamOptionsWithExtras) {
	// Check if the model supports images
	if (!model.input.includes("image")) {
		console.log(`Skipping tool image result test - model ${model.id} doesn't support images`);
		return;
	}

	// Read the test image
	const imagePath = join(__dirname, "data", "red-circle.png");
	const imageBuffer = readFileSync(imagePath);
	const base64Image = imageBuffer.toString("base64");

	// Define a tool that returns only an image (no text)
	const getImageSchema = Type.Object({});
	const getImageTool: Tool<typeof getImageSchema> = {
		name: "get_circle",
		description: "Returns a circle image for visualization",
		parameters: getImageSchema,
	};

	const context: Context = {
		systemPrompt: "You are a helpful assistant that uses tools when asked.",
		messages: [
			{
				role: "user",
				content: "Call the get_circle tool to get an image, and describe what you see, shapes, colors, etc.",
				timestamp: Date.now(),
			},
		],
		tools: [getImageTool],
	};

	// First request - LLM should call the tool
	const firstResponse = await complete(model, context, options);
	expect(firstResponse.stopReason).toBe("toolUse");

	// Find the tool call
	const toolCall = firstResponse.content.find((b) => b.type === "toolCall");
	expect(toolCall).toBeTruthy();
	if (!toolCall || toolCall.type !== "toolCall") {
		throw new Error("Expected tool call");
	}
	expect(toolCall.name).toBe("get_circle");

	// Add the tool call to context
	context.messages.push(firstResponse);

	// Create tool result with ONLY an image (no text)
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [
			{
				type: "image",
				data: base64Image,
				mimeType: "image/png",
			},
		],
		isError: false,
		timestamp: Date.now(),
	};

	context.messages.push(toolResult);

	// Second request - LLM should describe the image from the tool result
	const secondResponse = await complete(model, context, options);
	expect(secondResponse.stopReason).toBe("stop");
	expect(secondResponse.errorMessage).toBeFalsy();

	// Verify the LLM can see and describe the image
	const textContent = secondResponse.content.find((b) => b.type === "text");
	expect(textContent).toBeTruthy();
	if (textContent && textContent.type === "text") {
		const lowerContent = textContent.text.toLowerCase();
		// Should mention red and circle since that's what the image shows
		expect(lowerContent).toContain("red");
		expect(lowerContent).toContain("circle");
	}
}

/**
 * Test that tool results containing both text and images work correctly across all providers.
 * This verifies that:
 * 1. Tool results can contain mixed content blocks (text + images)
 * 2. Providers correctly pass both text and images from tool results to the LLM
 * 3. The LLM can see both the text and images in tool results
 */
async function handleToolWithTextAndImageResult<TApi extends Api>(
	model: Model<TApi>,
	options?: StreamOptionsWithExtras,
) {
	// Check if the model supports images
	if (!model.input.includes("image")) {
		console.log(`Skipping tool text+image result test - model ${model.id} doesn't support images`);
		return;
	}

	// Read the test image
	const imagePath = join(__dirname, "data", "red-circle.png");
	const imageBuffer = readFileSync(imagePath);
	const base64Image = imageBuffer.toString("base64");

	// Define a tool that returns both text and an image
	const getImageSchema = Type.Object({});
	const getImageTool: Tool<typeof getImageSchema> = {
		name: "get_circle_with_description",
		description: "Returns a circle image with a text description",
		parameters: getImageSchema,
	};

	const context: Context = {
		systemPrompt: "You are a helpful assistant that uses tools when asked.",
		messages: [
			{
				role: "user",
				content:
					"Use the get_circle_with_description tool and tell me what you learned. Also say what color the shape is.",
				timestamp: Date.now(),
			},
		],
		tools: [getImageTool],
	};

	// First request - LLM should call the tool
	const firstResponse = await complete(model, context, options);
	expect(firstResponse.stopReason).toBe("toolUse");

	// Find the tool call
	const toolCall = firstResponse.content.find((b) => b.type === "toolCall");
	expect(toolCall).toBeTruthy();
	if (!toolCall || toolCall.type !== "toolCall") {
		throw new Error("Expected tool call");
	}
	expect(toolCall.name).toBe("get_circle_with_description");

	// Add the tool call to context
	context.messages.push(firstResponse);

	// Create tool result with BOTH text and image
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [
			{
				type: "text",
				text: "This is a geometric shape with specific properties: it has a diameter of 100 pixels.",
			},
			{
				type: "image",
				data: base64Image,
				mimeType: "image/png",
			},
		],
		isError: false,
		timestamp: Date.now(),
	};

	context.messages.push(toolResult);

	// Second request - LLM should describe both the text and image from the tool result
	const secondResponse = await complete(model, context, options);
	expect(secondResponse.stopReason).toBe("stop");
	expect(secondResponse.errorMessage).toBeFalsy();

	// Verify the LLM can see both text and image
	const textContent = secondResponse.content.find((b) => b.type === "text");
	expect(textContent).toBeTruthy();
	if (textContent && textContent.type === "text") {
		const lowerContent = textContent.text.toLowerCase();
		// Should mention details from the text (diameter/pixels)
		expect(lowerContent.match(/diameter|100|pixel/)).toBeTruthy();
		// Should also mention the visual properties (red and circle)
		expect(lowerContent).toContain("red");
		expect(lowerContent).toContain("circle");
	}
}

const TEXT_AND_IMAGE_TITLE = "should handle tool result with text and image";

// FIXME(xiaomi): when a tool_result contains both a descriptive text block and an
// image block, MiMo locks onto the text and ignores the image (it reports the
// text-derived diameter but never mentions the image's color). The image-only case
// proves the image reaches the model, and the text-only path obviously works, so this
// is a multimodal-fusion quality issue in the model, not a transport bug. Re-enable
// when upstream model quality improves.
const XIAOMI_TEXT_AND_IMAGE_FIXME =
	"MiMo locks onto tool-result text and ignores the accompanying image (multimodal-fusion quality issue, not a transport bug)";

const PROVIDERS: ProviderCase[] = [
	{
		name: "Google Provider (gemini-2.5-flash)",
		hasCredentials: !!process.env.GEMINI_API_KEY,
		model: () => getModel("google", "gemini-2.5-flash"),
	},
	{
		name: "OpenAI Completions Provider (gpt-4o-mini)",
		hasCredentials: !!process.env.OPENAI_API_KEY,
		model: () => {
			const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
			void _compat;
			return { ...baseModel, api: "openai-completions" } satisfies Model<"openai-completions">;
		},
	},
	{
		name: "OpenAI Responses Provider (gpt-5-mini)",
		hasCredentials: !!process.env.OPENAI_API_KEY,
		model: () => getModel("openai", "gpt-5-mini"),
	},
	{
		name: "Azure OpenAI Responses Provider (gpt-4o-mini)",
		hasCredentials: hasAzureOpenAICredentials(),
		model: () => getModel("azure-openai-responses", "gpt-4o-mini"),
		options: (llm) => {
			const azureDeploymentName = resolveAzureDeploymentName(llm.id);
			return azureDeploymentName ? { azureDeploymentName } : {};
		},
	},
	{
		name: "Anthropic Provider (claude-haiku-4-5)",
		hasCredentials: !!process.env.ANTHROPIC_API_KEY,
		model: () => getModel("anthropic", "claude-haiku-4-5"),
	},
	{
		name: "OpenRouter Provider (glm-4.5v)",
		hasCredentials: !!process.env.OPENROUTER_API_KEY,
		model: () => getModel("openrouter", "z-ai/glm-4.5v"),
	},
	{
		name: "Mistral Provider (pixtral-12b)",
		hasCredentials: !!process.env.MISTRAL_API_KEY,
		model: () => getModel("mistral", "pixtral-12b"),
	},
	{
		name: "Together AI Provider (Kimi-K2.6)",
		hasCredentials: !!process.env.TOGETHER_API_KEY,
		model: () => getModel("together", "moonshotai/Kimi-K2.6"),
		options: { reasoningEffort: "high" },
	},
	{
		name: "Xiaomi MiMo (API billing) Provider (mimo-v2.5-pro)",
		hasCredentials: !!process.env.XIAOMI_API_KEY,
		model: () => getModel("xiaomi", "mimo-v2.5-pro"),
		scenarioSkipReasons: { [TEXT_AND_IMAGE_TITLE]: XIAOMI_TEXT_AND_IMAGE_FIXME },
	},
	{
		name: "Xiaomi MiMo Token Plan (CN) Provider (mimo-v2.5-pro)",
		hasCredentials: !!process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY,
		model: () => getModel("xiaomi-token-plan-cn", "mimo-v2.5-pro"),
		scenarioSkipReasons: { [TEXT_AND_IMAGE_TITLE]: XIAOMI_TEXT_AND_IMAGE_FIXME },
	},
	{
		name: "Xiaomi MiMo Token Plan (AMS) Provider (mimo-v2.5-pro)",
		hasCredentials: !!process.env.XIAOMI_TOKEN_PLAN_AMS_API_KEY,
		model: () => getModel("xiaomi-token-plan-ams", "mimo-v2.5-pro"),
		scenarioSkipReasons: { [TEXT_AND_IMAGE_TITLE]: XIAOMI_TEXT_AND_IMAGE_FIXME },
	},
	{
		name: "Xiaomi MiMo Token Plan (SGP) Provider (mimo-v2.5-pro)",
		hasCredentials: !!process.env.XIAOMI_TOKEN_PLAN_SGP_API_KEY,
		model: () => getModel("xiaomi-token-plan-sgp", "mimo-v2.5-pro"),
		scenarioSkipReasons: { [TEXT_AND_IMAGE_TITLE]: XIAOMI_TEXT_AND_IMAGE_FIXME },
	},
	{
		name: "Kimi For Coding Provider (kimi-for-coding)",
		hasCredentials: !!process.env.KIMI_API_KEY,
		model: () => getModel("kimi-coding", "kimi-for-coding"),
	},
	{
		name: "Vercel AI Gateway Provider (google/gemini-2.5-flash)",
		hasCredentials: !!process.env.AI_GATEWAY_API_KEY,
		model: () => getModel("vercel-ai-gateway", "google/gemini-2.5-flash"),
	},
	{
		name: "Amazon Bedrock Provider (claude-sonnet-4-5)",
		hasCredentials: hasBedrockCredentials(),
		model: () => getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0"),
	},
	// =========================================================================
	// OAuth-based providers (credentials from Alef agent dir `oauth.json`)
	// =========================================================================
	{
		name: "Anthropic OAuth Provider (claude-sonnet-4-5)",
		hasCredentials: !!anthropicOAuthToken,
		model: () => getModel("anthropic", "claude-sonnet-4-5"),
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

describeProviders(
	"Tool Results with Images",
	PROVIDERS,
	[
		{
			title: "should handle tool result with only image",
			run: async (_ctx, llm, options) => {
				await handleToolWithImageResult(llm, options);
			},
		},
		{
			title: TEXT_AND_IMAGE_TITLE,
			run: async (_ctx, llm, options) => {
				await handleToolWithTextAndImageResult(llm, options);
			},
		},
	],
	{ tags: ["real-llm"] },
);
