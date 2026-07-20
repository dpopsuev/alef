import { getModel } from "../src/models/llm.js";
import { complete } from "../src/stream.js";
import type { Api, Context, Model, StreamOptions } from "../src/types.js";

import type { TestContext } from "vitest";
import { expect } from "vitest";
import { skipIfQuotaExceeded, withStatusCapture } from "./api-status.js";
import { hasAzureOpenAICredentials, resolveAzureDeploymentName } from "./azure-utils.js";
import { resolveApiKey } from "./oauth.js";
import { describeProviders, type ProviderCase } from "./provider-matrix.js";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

const oauthTokens = await Promise.all([resolveApiKey("github-copilot"), resolveApiKey("openai-codex")]);
const [githubCopilotToken, openaiCodexToken] = oauthTokens;

async function expectResponseId<TApi extends Api>(
	ctx: TestContext,
	model: Model<TApi>,
	options: StreamOptionsWithExtras = {},
) {
	const context: Context = {
		systemPrompt: "You are a helpful assistant. Be concise.",
		messages: [{ role: "user", content: "Reply with exactly: response id test", timestamp: Date.now() }],
	};

	const capture = withStatusCapture(options);
	const response = await complete(model, context, capture.options);
	skipIfQuotaExceeded(ctx, capture.getStatus(), response.errorMessage);

	expect(response.stopReason, response.errorMessage).not.toBe("error");
	expect(response.responseId).toBeTruthy();
	expect(typeof response.responseId).toBe("string");
}

const vertexProject = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
const vertexLocation = process.env.GOOGLE_CLOUD_LOCATION;
const vertexApiKey = process.env.GOOGLE_CLOUD_API_KEY;
const isVertexAdcConfigured = Boolean(vertexProject && vertexLocation);

const PROVIDERS: ProviderCase[] = [
	{
		name: "Google Provider",
		hasCredentials: !!process.env.GEMINI_API_KEY,
		model: () => getModel("google", "gemini-2.5-flash"),
	},
	{
		name: "Google Vertex Provider (ADC)",
		hasCredentials: isVertexAdcConfigured,
		model: () => getModel("google-vertex", "gemini-3-flash-preview"),
		options: { project: vertexProject, location: vertexLocation },
	},
	{
		name: "Google Vertex Provider (API key)",
		hasCredentials: !!vertexApiKey,
		model: () => getModel("google-vertex", "gemini-3-flash-preview"),
		options: { apiKey: vertexApiKey },
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
		name: "Anthropic Provider",
		hasCredentials: !!process.env.ANTHROPIC_API_KEY,
		model: () => getModel("anthropic", "claude-sonnet-4-5"),
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
		name: "Mistral Provider",
		hasCredentials: !!process.env.MISTRAL_API_KEY,
		model: () => getModel("mistral", "devstral-medium-latest"),
	},
	// =========================================================================
	// OAuth-based providers (credentials from Alef agent dir `oauth.json`)
	// =========================================================================
	{
		name: "GitHub Copilot Provider (OpenAI path)",
		hasCredentials: !!githubCopilotToken,
		model: () => getModel("github-copilot", "gpt-5.3-codex"),
		options: { apiKey: githubCopilotToken },
	},
	{
		name: "GitHub Copilot Provider (Anthropic path)",
		hasCredentials: !!githubCopilotToken,
		model: () => getModel("github-copilot", "claude-sonnet-4.5"),
		options: { apiKey: githubCopilotToken },
	},
	{
		name: "OpenAI Codex Provider",
		hasCredentials: !!openaiCodexToken,
		model: () => getModel("openai-codex", "gpt-5.2-codex"),
		options: { apiKey: openaiCodexToken },
	},
];

describeProviders("responseId E2E Tests", PROVIDERS, [
	{
		title: "should expose responseId",
		run: async (ctx, llm, options) => {
			await expectResponseId(ctx, llm, options);
		},
	},
]);
