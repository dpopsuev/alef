import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BootstrapLocalEndpointId, BootstrapOpenAICompatibleEndpoint } from "./types.js";

interface ModelsJsonModelConfig {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
}

interface ModelsJsonProviderConfig {
	name?: string;
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	compat?: {
		supportsDeveloperRole?: boolean;
		supportsReasoningEffort?: boolean;
		supportsUsageInStreaming?: boolean;
		maxTokensField?: "max_completion_tokens" | "max_tokens";
	};
	models?: ModelsJsonModelConfig[];
}

interface ModelsJsonConfig {
	providers: Record<string, ModelsJsonProviderConfig>;
}

export interface BootstrapLocalProviderSelection {
	providerId: string;
	providerName: string;
	endpointId: BootstrapLocalEndpointId;
	baseUrl: string;
	modelId: string;
	modelName: string;
}

function stripJsonComments(input: string): string {
	return input
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ""))
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail) => tail ?? (match[0] === '"' ? match : ""));
}

function readModelsJson(path: string): ModelsJsonConfig {
	if (!existsSync(path)) {
		return { providers: {} };
	}

	const content = readFileSync(path, "utf-8").trim();
	if (!content) {
		return { providers: {} };
	}

	const parsed = JSON.parse(stripJsonComments(content)) as unknown;
	if (!parsed || typeof parsed !== "object" || !("providers" in parsed)) {
		throw new Error(`Invalid models.json at ${path}: expected a top-level "providers" object.`);
	}

	const providers = (parsed as { providers?: unknown }).providers;
	if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
		throw new Error(`Invalid models.json at ${path}: "providers" must be an object.`);
	}

	return { providers: providers as Record<string, ModelsJsonProviderConfig> };
}

function createBootstrapProviderConfig(selection: BootstrapLocalProviderSelection): ModelsJsonProviderConfig {
	return {
		name: selection.providerName,
		baseUrl: selection.baseUrl,
		api: "openai-completions",
		apiKey: selection.endpointId === "ollama" ? "ollama" : "lmstudio",
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			supportsUsageInStreaming: false,
			maxTokensField: "max_tokens",
		},
		models: [
			{
				id: selection.modelId,
				name: selection.modelName,
				reasoning: false,
				input: ["text"],
				contextWindow: 128000,
				maxTokens: 8192,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
				},
			},
		],
	};
}

export function buildBootstrapLocalProviderSelection(
	endpoint: BootstrapOpenAICompatibleEndpoint,
	modelId: string,
): BootstrapLocalProviderSelection {
	const label = endpoint.id === "ollama" ? "Local OSS via Ollama" : "Local OSS via LM Studio";
	return {
		providerId: endpoint.id === "ollama" ? "local-ollama" : "local-lmstudio",
		providerName: label,
		endpointId: endpoint.id,
		baseUrl: endpoint.baseUrl,
		modelId,
		modelName: `${modelId} (${endpoint.label})`,
	};
}

export function upsertBootstrapLocalProviderConfig(
	modelsJsonPath: string,
	selection: BootstrapLocalProviderSelection,
): void {
	const config = readModelsJson(modelsJsonPath);
	config.providers[selection.providerId] = createBootstrapProviderConfig(selection);

	const parentDir = dirname(modelsJsonPath);
	if (!existsSync(parentDir)) {
		mkdirSync(parentDir, { recursive: true });
	}

	writeFileSync(modelsJsonPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}
