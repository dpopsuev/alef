/**
 * Example: Ollama provider for Alef.
 *
 * Demonstrates the ProviderFactory contract:
 *   1. Import types from @dpopsuev/alef-llm/provider-port and /provider-contract
 *   2. Export a createProvider() factory
 *   3. Return ApiProvider registrations + model catalog entries
 *
 * Install:
 *   alef install @example/alef-provider-ollama
 *
 * The installer reads package.json → alef.type === "provider" → calls createProvider()
 * → registers the ApiProvider with the LLM registry → models appear in --list-models.
 */

import type { ApiProvider } from "@dpopsuev/alef-llm/provider-port";
import type { ProviderFactory, ProviderModelDefinition } from "@dpopsuev/alef-llm/provider-contract";
import type { Context, Model, SimpleStreamOptions, StreamOptions } from "@dpopsuev/alef-llm/types";
import { AssistantMessageEventStream } from "@dpopsuev/alef-llm";

const OLLAMA_DEFAULT_URL = "http://localhost:11434";

type OllamaApi = "ollama-chat";

interface OllamaOptions extends StreamOptions {
	temperature?: number;
	topP?: number;
}

function streamOllama(
	model: Model<OllamaApi>,
	context: Context,
	options?: OllamaOptions,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const baseUrl = model.baseUrl ?? OLLAMA_DEFAULT_URL;

	(async () => {
		const messages = context.messages.map((m) => ({
			role: m.role,
			content: "content" in m && typeof m.content === "string" ? m.content : "",
		}));

		const resp = await fetch(`${baseUrl}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: model.id,
				messages,
				stream: true,
				options: {
					temperature: options?.temperature,
					top_p: options?.topP,
				},
			}),
			signal: options?.abortSignal,
		});

		if (!resp.ok || !resp.body) {
			stream.push({
				type: "error",
				reason: "error",
				error: {
					role: "assistant",
					content: [],
					api: "ollama-chat" as OllamaApi,
					provider: "ollama",
					model: model.id,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "error",
					errorMessage: `Ollama HTTP ${resp.status}: ${resp.statusText}`,
					timestamp: Date.now(),
				},
			});
			return;
		}

		const reader = resp.body.getReader();
		const decoder = new TextDecoder();
		let fullText = "";

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const chunk = decoder.decode(value, { stream: true });
			for (const line of chunk.split("\n").filter(Boolean)) {
				try {
					const parsed = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
					const text = parsed.message?.content ?? "";
					if (text) {
						fullText += text;
						stream.push({ type: "text", text });
					}
				} catch {
					// skip malformed lines
				}
			}
		}

		stream.end({
			role: "assistant",
			content: [{ type: "text", text: fullText }],
			api: "ollama-chat" as OllamaApi,
			provider: "ollama",
			model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "end_turn",
			timestamp: Date.now(),
		});
	})().catch((err) => {
		stream.push({
			type: "error",
			reason: "error",
			error: {
				role: "assistant",
				content: [],
				api: "ollama-chat" as OllamaApi,
				provider: "ollama",
				model: model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "error",
				errorMessage: err instanceof Error ? err.message : String(err),
				timestamp: Date.now(),
			},
		});
	});

	return stream;
}

const MODELS: ProviderModelDefinition[] = [
	{ id: "llama3.3", name: "Llama 3.3 70B", provider: "ollama", api: "ollama-chat" as OllamaApi, contextWindow: 128000, maxTokens: 4096 },
	{ id: "qwen3", name: "Qwen 3", provider: "ollama", api: "ollama-chat" as OllamaApi, contextWindow: 128000, maxTokens: 4096 },
	{ id: "deepseek-r1", name: "DeepSeek R1", provider: "ollama", api: "ollama-chat" as OllamaApi, contextWindow: 128000, maxTokens: 4096 },
	{ id: "mistral", name: "Mistral 7B", provider: "ollama", api: "ollama-chat" as OllamaApi, contextWindow: 32000, maxTokens: 4096 },
	{ id: "codestral", name: "Codestral", provider: "ollama", api: "ollama-chat" as OllamaApi, contextWindow: 32000, maxTokens: 4096 },
];

export const createProvider: ProviderFactory<OllamaApi, OllamaOptions> = (opts) => {
	const provider: ApiProvider<OllamaApi, OllamaOptions> = {
		api: "ollama-chat" as OllamaApi,
		stream: streamOllama,
		streamSimple: (model, context, simpleOpts) => streamOllama(model, context, simpleOpts as OllamaOptions),
	};

	const models = MODELS.map((m) => ({
		...m,
		...(opts?.baseUrl ? { baseUrl: opts.baseUrl } : {}),
	}));

	return { providers: [provider], models };
};
