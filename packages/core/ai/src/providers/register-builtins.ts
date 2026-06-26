import { clearApiProviders, registerApiProvider } from "../models/registry.js";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import type { BedrockOptions } from "./amazon-bedrock.js";
import type { AnthropicOptions } from "./anthropic.js";
import type { AzureOpenAIResponsesOptions } from "./azure-openai-responses.js";
import type { GoogleOptions } from "./google/google.js";
import type { GoogleVertexOptions } from "./google/vertex.js";
import type { MistralOptions } from "./mistral.js";
import type { OpenAICodexResponsesOptions } from "./codex/responses.js";

function matchesAnthropicVertex(model: Model<Api>): boolean {
	if (typeof process === "undefined") return false;
	const projectId =
		process.env.ANTHROPIC_VERTEX_PROJECT_ID?.trim() ??
		process.env.GOOGLE_CLOUD_PROJECT?.trim() ??
		process.env.GCLOUD_PROJECT?.trim();
	const region = process.env.CLOUD_ML_REGION?.trim() ?? process.env.GOOGLE_CLOUD_LOCATION?.trim();
	return model.provider === "anthropic" && Boolean(projectId && region);
}

function matchesGitHubCopilot(model: Model<Api>): boolean {
	return model.provider === "github-copilot";
}
import type { OpenAICompletionsOptions } from "./openai/completions.js";
import type { OpenAIResponsesOptions } from "./openai/responses.js";

interface LazyProviderModule<
	TApi extends Api,
	TOptions extends StreamOptions,
	TSimpleOptions extends SimpleStreamOptions,
> {
	stream: (model: Model<TApi>, context: Context, options?: TOptions) => AsyncIterable<AssistantMessageEvent>;
	streamSimple: (
		model: Model<TApi>,
		context: Context,
		options?: TSimpleOptions,
	) => AsyncIterable<AssistantMessageEvent>;
}

interface BedrockProviderModule {
	streamBedrock: (
		model: Model<"bedrock-converse-stream">,
		context: Context,
		options?: BedrockOptions,
	) => AsyncIterable<AssistantMessageEvent>;
	streamSimpleBedrock: (
		model: Model<"bedrock-converse-stream">,
		context: Context,
		options?: SimpleStreamOptions,
	) => AsyncIterable<AssistantMessageEvent>;
}

// Prevents bundlers from statically analysing the Bedrock import path.
const importNodeOnlyProvider = (specifier: string): Promise<unknown> => import(specifier);

// Memoises a factory so the dynamic import only fires once per process.
function memoize<T>(fn: () => Promise<T>): () => Promise<T> {
	let cached: Promise<T> | undefined;
	return () => {
		cached ??= fn();
		return cached;
	};
}

// ---------------------------------------------------------------------------
// Per-provider lazy loaders — one function per provider, one edit site each.
// Adding a new provider: add one const here, one export pair below, one
// registerApiProvider() call in registerBuiltInApiProviders().
// ---------------------------------------------------------------------------

const loadAnthropicProviderModule = memoize(() =>
	import("./anthropic.js").then((m) => ({
		stream: m.streamAnthropic as StreamFunction<"anthropic-messages", AnthropicOptions>,
		streamSimple: m.streamSimpleAnthropic as StreamFunction<"anthropic-messages", SimpleStreamOptions>,
	})),
);

const loadAnthropicVertexProviderModule = memoize(() =>
	import("./anthropic-vertex.js").then((m) => ({
		stream: m.streamAnthropicVertex as StreamFunction<"anthropic-messages", AnthropicOptions>,
		streamSimple: m.streamSimpleAnthropicVertex as StreamFunction<"anthropic-messages", SimpleStreamOptions>,
	})),
);

const loadGitHubCopilotCompletionsProviderModule = memoize(() =>
	import("./github-copilot-openai-completions.js").then((m) => ({
		stream: m.streamGitHubCopilotCompletions as StreamFunction<"openai-completions", OpenAICompletionsOptions>,
		streamSimple: m.streamSimpleGitHubCopilotCompletions as StreamFunction<"openai-completions", SimpleStreamOptions>,
	})),
);

const loadAzureOpenAIResponsesProviderModule = memoize(() =>
	import("./azure-openai-responses.js").then((m) => ({
		stream: m.streamAzureOpenAIResponses as StreamFunction<"azure-openai-responses", AzureOpenAIResponsesOptions>,
		streamSimple: m.streamSimpleAzureOpenAIResponses as StreamFunction<"azure-openai-responses", SimpleStreamOptions>,
	})),
);

const loadGoogleProviderModule = memoize(() =>
	import("./google/google.js").then((m) => ({
		stream: m.streamGoogle as StreamFunction<"google-generative-ai", GoogleOptions>,
		streamSimple: m.streamSimpleGoogle as StreamFunction<"google-generative-ai", SimpleStreamOptions>,
	})),
);

const loadGoogleVertexProviderModule = memoize(() =>
	import("./google/vertex.js").then((m) => ({
		stream: m.streamGoogleVertex as StreamFunction<"google-vertex", GoogleVertexOptions>,
		streamSimple: m.streamSimpleGoogleVertex as StreamFunction<"google-vertex", SimpleStreamOptions>,
	})),
);

const loadMistralProviderModule = memoize(() =>
	import("./mistral.js").then((m) => ({
		stream: m.streamMistral as StreamFunction<"mistral-conversations", MistralOptions>,
		streamSimple: m.streamSimpleMistral as StreamFunction<"mistral-conversations", SimpleStreamOptions>,
	})),
);

const loadOpenAICodexResponsesProviderModule = memoize(() =>
	import("./codex/responses.js").then((m) => ({
		stream: m.streamOpenAICodexResponses as StreamFunction<"openai-codex-responses", OpenAICodexResponsesOptions>,
		streamSimple: m.streamSimpleOpenAICodexResponses as StreamFunction<"openai-codex-responses", SimpleStreamOptions>,
	})),
);

const loadOpenAICompletionsProviderModule = memoize(() =>
	import("./openai/completions.js").then((m) => ({
		stream: m.streamOpenAICompletions as StreamFunction<"openai-completions", OpenAICompletionsOptions>,
		streamSimple: m.streamSimpleOpenAICompletions as StreamFunction<"openai-completions", SimpleStreamOptions>,
	})),
);

const loadOpenAIResponsesProviderModule = memoize(() =>
	import("./openai/responses.js").then((m) => ({
		stream: m.streamOpenAIResponses as StreamFunction<"openai-responses", OpenAIResponsesOptions>,
		streamSimple: m.streamSimpleOpenAIResponses as StreamFunction<"openai-responses", SimpleStreamOptions>,
	})),
);

let bedrockProviderModuleOverride:
	| LazyProviderModule<"bedrock-converse-stream", BedrockOptions, SimpleStreamOptions>
	| undefined;
let bedrockProviderModulePromise:
	| Promise<LazyProviderModule<"bedrock-converse-stream", BedrockOptions, SimpleStreamOptions>>
	| undefined;

export function setBedrockProviderModule(module: BedrockProviderModule): void {
	bedrockProviderModuleOverride = {
		stream: module.streamBedrock,
		streamSimple: module.streamSimpleBedrock,
	};
}

function forwardStream(target: AssistantMessageEventStream, source: AsyncIterable<AssistantMessageEvent>): void {
	(async () => {
		for await (const event of source) {
			target.push(event);
		}
		target.end();
	})();
}

function createLazyLoadErrorMessage<TApi extends Api>(model: Model<TApi>, error: unknown): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

function createLazyStream<TApi extends Api, TOptions extends StreamOptions, TSimpleOptions extends SimpleStreamOptions>(
	loadModule: () => Promise<LazyProviderModule<TApi, TOptions, TSimpleOptions>>,
): StreamFunction<TApi, TOptions> {
	return (model, context, options) => {
		const outer = new AssistantMessageEventStream();

		loadModule()
			.then((module) => {
				const inner = module.stream(model, context, options);
				forwardStream(outer, inner);
			})
			.catch((error) => {
				const message = createLazyLoadErrorMessage(model, error);
				outer.push({ type: "error", reason: "error", error: message });
				outer.end(message);
			});

		return outer;
	};
}

function createLazySimpleStream<
	TApi extends Api,
	TOptions extends StreamOptions,
	TSimpleOptions extends SimpleStreamOptions,
>(loadModule: () => Promise<LazyProviderModule<TApi, TOptions, TSimpleOptions>>): StreamFunction<TApi, TSimpleOptions> {
	return (model, context, options) => {
		const outer = new AssistantMessageEventStream();

		loadModule()
			.then((module) => {
				const inner = module.streamSimple(model, context, options);
				forwardStream(outer, inner);
			})
			.catch((error) => {
				const message = createLazyLoadErrorMessage(model, error);
				outer.push({ type: "error", reason: "error", error: message });
				outer.end(message);
			});

		return outer;
	};
}

function loadBedrockProviderModule(): Promise<
	LazyProviderModule<"bedrock-converse-stream", BedrockOptions, SimpleStreamOptions>
> {
	if (bedrockProviderModuleOverride) {
		return Promise.resolve(bedrockProviderModuleOverride);
	}
	bedrockProviderModulePromise ??= importNodeOnlyProvider("./amazon-bedrock.js").then((module) => {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- boundary cast: dynamic import returns unknown module shape
		const provider = module as BedrockProviderModule;
		return {
			stream: provider.streamBedrock,
			streamSimple: provider.streamSimpleBedrock,
		};
	});
	return bedrockProviderModulePromise;
}

export const streamAnthropicVertex = createLazyStream(loadAnthropicVertexProviderModule);
export const streamSimpleAnthropicVertex = createLazySimpleStream(loadAnthropicVertexProviderModule);
export const streamGitHubCopilotCompletions = createLazyStream(loadGitHubCopilotCompletionsProviderModule);
export const streamSimpleGitHubCopilotCompletions = createLazySimpleStream(loadGitHubCopilotCompletionsProviderModule);
export const streamAnthropic = createLazyStream(loadAnthropicProviderModule);
export const streamSimpleAnthropic = createLazySimpleStream(loadAnthropicProviderModule);
export const streamAzureOpenAIResponses = createLazyStream(loadAzureOpenAIResponsesProviderModule);
export const streamSimpleAzureOpenAIResponses = createLazySimpleStream(loadAzureOpenAIResponsesProviderModule);
export const streamGoogle = createLazyStream(loadGoogleProviderModule);
export const streamSimpleGoogle = createLazySimpleStream(loadGoogleProviderModule);
export const streamGoogleVertex = createLazyStream(loadGoogleVertexProviderModule);
export const streamSimpleGoogleVertex = createLazySimpleStream(loadGoogleVertexProviderModule);
export const streamMistral = createLazyStream(loadMistralProviderModule);
export const streamSimpleMistral = createLazySimpleStream(loadMistralProviderModule);
export const streamOpenAICodexResponses = createLazyStream(loadOpenAICodexResponsesProviderModule);
export const streamSimpleOpenAICodexResponses = createLazySimpleStream(loadOpenAICodexResponsesProviderModule);
export const streamOpenAICompletions = createLazyStream(loadOpenAICompletionsProviderModule);
export const streamSimpleOpenAICompletions = createLazySimpleStream(loadOpenAICompletionsProviderModule);
export const streamOpenAIResponses = createLazyStream(loadOpenAIResponsesProviderModule);
export const streamSimpleOpenAIResponses = createLazySimpleStream(loadOpenAIResponsesProviderModule);
const streamBedrockLazy = createLazyStream(loadBedrockProviderModule);
const streamSimpleBedrockLazy = createLazySimpleStream(loadBedrockProviderModule);

// Registration order matters: specific strategies (with match()) before fallbacks.
// Adding a new provider: add one lazy loader above, one export pair, one entry here.
const BUILTIN_PROVIDERS: ReadonlyArray<{
	api: Api;
	stream: StreamFunction<Api, StreamOptions>;
	streamSimple: StreamFunction<Api, SimpleStreamOptions>;
	match?: (model: Model<Api>) => boolean;
}> = [
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowly-typed providers widen to Api union for registry iteration
	{ api: "anthropic-messages", stream: streamAnthropicVertex, streamSimple: streamSimpleAnthropicVertex, match: matchesAnthropicVertex },
	{ api: "anthropic-messages", stream: streamAnthropic, streamSimple: streamSimpleAnthropic },
	{ api: "openai-completions", stream: streamGitHubCopilotCompletions, streamSimple: streamSimpleGitHubCopilotCompletions, match: matchesGitHubCopilot },
	{ api: "openai-completions", stream: streamOpenAICompletions, streamSimple: streamSimpleOpenAICompletions },
	{ api: "mistral-conversations", stream: streamMistral, streamSimple: streamSimpleMistral },
	{ api: "openai-responses", stream: streamOpenAIResponses, streamSimple: streamSimpleOpenAIResponses },
	{ api: "azure-openai-responses", stream: streamAzureOpenAIResponses, streamSimple: streamSimpleAzureOpenAIResponses },
	{ api: "openai-codex-responses", stream: streamOpenAICodexResponses, streamSimple: streamSimpleOpenAICodexResponses },
	{ api: "google-generative-ai", stream: streamGoogle, streamSimple: streamSimpleGoogle },
	{ api: "google-vertex", stream: streamGoogleVertex, streamSimple: streamSimpleGoogleVertex },
	{ api: "bedrock-converse-stream", stream: streamBedrockLazy, streamSimple: streamSimpleBedrockLazy },
] as unknown as ReadonlyArray<{
	api: Api;
	stream: StreamFunction<Api, StreamOptions>;
	streamSimple: StreamFunction<Api, SimpleStreamOptions>;
	match?: (model: Model<Api>) => boolean;
}>;

export function registerBuiltInApiProviders(): void {
	for (const entry of BUILTIN_PROVIDERS) {
		registerApiProvider(entry);
	}
}

export function resetApiProviders(): void {
	clearApiProviders();
	registerBuiltInApiProviders();
}

registerBuiltInApiProviders();
