/**
 * FauxProvider — in-process mock LLM for deterministic testing.
 *
 * Implements the full streaming API at the TypeScript function boundary.
 * No HTTP, no subprocess, no API keys required.
 *
 * Emits real token-by-token events with configurable tokensPerSecond so
 * tests can exercise the full pipe: FauxProvider → adapter-llm → TUI render.
 *
 * Ported from pi-mono packages/ai/src/providers/faux.ts (MIT).
 *
 * Usage:
 *   const faux = registerFauxProvider({ tokensPerSecond: 200 });
 *   faux.setResponses([fauxAssistantMessage("Hello from faux LLM")]);
 *   // ... run agent ...
 *   faux.unregister();
 */

import { registerApiProvider, unregisterApiProviders } from "../models/registry.js";
import type {
	AssistantMessage,
	Context,
	ImageContent,
	Message,
	Model,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	Usage,
} from "../types.js";
import { formatThrownValue } from "../utils/diagnostics.js";
import { createAssistantMessageEventStream } from "../utils/event-stream.js";

const DEFAULT_API_PREFIX = "faux";
const DEFAULT_PROVIDER = "faux";
const DEFAULT_MODEL_ID = "faux-1";
const DEFAULT_MODEL_NAME = "Faux Model";
const DEFAULT_BASE_URL = "http://localhost:0";
const DEFAULT_MIN_TOKEN_SIZE = 3;
const DEFAULT_MAX_TOKEN_SIZE = 5;

const DEFAULT_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 *
 */
export interface FauxModelDefinition {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow?: number;
	maxTokens?: number;
}

/**
 *
 */
function buildFauxModel(def: FauxModelDefinition, api: string, provider: string): Model<string> {
	return {
		id: def.id,
		name: def.name ?? def.id,
		api,
		provider,
		baseUrl: DEFAULT_BASE_URL,
		reasoning: def.reasoning ?? false,
		input: def.input ?? ["text", "image"],
		cost: def.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		// eslint-disable-next-line no-magic-numbers
		contextWindow: def.contextWindow ?? 128_000,
		// eslint-disable-next-line no-magic-numbers
		maxTokens: def.maxTokens ?? 16_384,
	};
}

/**
 *
 */
export type FauxContentBlock = TextContent | ThinkingContent | ToolCall;

/**
 *
 */
export function fauxText(text: string): TextContent {
	return { type: "text", text };
}

/**
 *
 */
export function fauxThinking(thinking: string): ThinkingContent {
	return { type: "thinking", thinking };
}

/**
 *
 */
export function fauxToolCall(name: string, args: ToolCall["arguments"], options: { id?: string } = {}): ToolCall {
	const id =
		options.id ??
		(typeof globalThis.crypto.randomUUID === "function"
			? globalThis.crypto.randomUUID()
			// eslint-disable-next-line no-magic-numbers
			: `tool:${Math.random().toString(36).slice(2)}`);
	return { type: "toolCall", id, name, arguments: args };
}

/**
 *
 */
function normalizeContent(content: string | FauxContentBlock | FauxContentBlock[]): FauxContentBlock[] {
	if (typeof content === "string") return [fauxText(content)];
	return Array.isArray(content) ? content : [content];
}

/**
 *
 */
export function fauxAssistantMessage(
	content: string | FauxContentBlock | FauxContentBlock[],
	options: {
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
	} = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: normalizeContent(content),
		api: DEFAULT_API_PREFIX,
		provider: DEFAULT_PROVIDER,
		model: DEFAULT_MODEL_ID,
		usage: DEFAULT_USAGE,
		stopReason: options.stopReason ?? "stop",
		errorMessage: options.errorMessage,
		timestamp: Date.now(),
	};
}

/**
 *
 */
export type FauxResponseFactory = (
	context: Context,
	options: StreamOptions | undefined,
	state: { callCount: number },
	model: Model<string>,
) => AssistantMessage | Promise<AssistantMessage>;

/**
 *
 */
export type FauxResponseStep = AssistantMessage | FauxResponseFactory;

/**
 *
 */
export interface RegisterFauxProviderOptions {
	/** Override the API identifier (default: auto-generated unique string). */
	api?: string;
	/** Override the provider name (default: 'faux'). */
	provider?: string;
	/** Model definitions exposed by this provider. Default: one model "faux-1". */
	models?: FauxModelDefinition[];
	/** Simulated token delivery speed. 0 = instant (microtask). Default: instant. */
	tokensPerSecond?: number;
	/** Chunk size range (chars per chunk ≈ token). Default: 3–5. */
	tokenSize?: { min?: number; max?: number };
}

/**
 *
 */
export interface FauxProviderRegistration {
	/** API identifier — use when registering with ModelRegistry. */
	api: string;
	models: [Model<string>, ...Model<string>[]];
	getModel(): Model<string>;
	getModel(modelId: string): Model<string> | undefined;
	state: { callCount: number };
	setResponses(responses: FauxResponseStep[]): void;
	appendResponses(responses: FauxResponseStep[]): void;
	getPendingResponseCount(): number;
	unregister(): void;
}

/**
 *
 */
function estimateTokens(text: string): number {
	// eslint-disable-next-line no-magic-numbers
	return Math.ceil(text.length / 4);
}

/**
 *
 */
function splitByTokenSize(text: string, min: number, max: number): string[] {
	const chunks: string[] = [];
	let i = 0;
	while (i < text.length) {
		const tokenSize = min + Math.floor(Math.random() * (max - min + 1));
		// eslint-disable-next-line no-magic-numbers
		const charSize = Math.max(1, tokenSize * 4);
		chunks.push(text.slice(i, i + charSize));
		i += charSize;
	}
	return chunks.length > 0 ? chunks : [""];
}

/**
 *
 */
function contentToText(content: string | Array<TextContent | ImageContent>): string {
	if (typeof content === "string") return content;
	return content.map((b) => (b.type === "text" ? b.text : `[image:${b.mimeType}]`)).join("\n");
}

/**
 *
 */
function messageToText(msg: Message): string {
	if (msg.role === "user") return contentToText(msg.content);
	if (msg.role === "assistant")
		return msg.content
			.map((b) =>
				b.type === "text"
					? b.text
					: b.type === "thinking"
						? b.thinking
						: `${b.name}:${JSON.stringify(b.arguments)}`,
			)
			.join("\n");
	const tr = msg as ToolResultMessage;
	return [tr.toolName, ...tr.content.map((b) => contentToText([b]))].join("\n");
}

/**
 *
 */
function serializeContext(ctx: Context): string {
	const parts: string[] = [];
	if (ctx.systemPrompt) parts.push(`system:${ctx.systemPrompt}`);
	for (const m of ctx.messages) parts.push(`${m.role}:${messageToText(m)}`);
	if (ctx.tools?.length) parts.push(`tools:${JSON.stringify(ctx.tools)}`);
	return parts.join("\n\n");
}

/**
 *
 */
function commonPrefixLen(a: string, b: string): number {
	const len = Math.min(a.length, b.length);
	let i = 0;
	while (i < len && a[i] === b[i]) i++;
	return i;
}

/**
 *
 */
function withUsage(
	msg: AssistantMessage,
	ctx: Context,
	opts: StreamOptions | undefined,
	cache: Map<string, string>,
): AssistantMessage {
	const prompt = serializeContext(ctx);
	const promptTokens = estimateTokens(prompt);
	const outputTokens = estimateTokens(
		msg.content.map((b) => (b.type === "text" ? b.text : b.type === "thinking" ? b.thinking : "")).join(""),
	);
	let input = promptTokens;
	let cacheRead = 0;
	let cacheWrite = 0;
	const sid = opts?.sessionId;
	if (sid && opts.cacheRetention !== "none") {
		const prev = cache.get(sid);
		if (prev) {
			const cached = commonPrefixLen(prev, prompt);
			cacheRead = estimateTokens(prev.slice(0, cached));
			cacheWrite = estimateTokens(prompt.slice(cached));
			input = Math.max(0, promptTokens - cacheRead);
		} else {
			cacheWrite = promptTokens;
		}
		cache.set(sid, prompt);
	}
	return {
		...msg,
		usage: {
			input,
			output: outputTokens,
			cacheRead,
			cacheWrite,
			totalTokens: input + outputTokens + cacheRead + cacheWrite,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

/**
 *
 */
function scheduleChunk(chunk: string, tps: number | undefined): Promise<void> {
	if (!tps || tps <= 0) return new Promise((r) => queueMicrotask(r));
	// eslint-disable-next-line no-magic-numbers
	const delayMs = (estimateTokens(chunk) / tps) * 1000;
	return new Promise((r) => setTimeout(r, delayMs));
}

/**
 *
 */
function cloneMsg(msg: AssistantMessage, api: string, provider: string, modelId: string): AssistantMessage {
	return {
		...structuredClone(msg),
		api,
		provider,
		model: modelId,
		timestamp: msg.timestamp,
		usage: msg.usage,
	};
}

/**
 *
 */
function errorMsg(err: unknown, api: string, provider: string, modelId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api,
		provider,
		model: modelId,
		usage: DEFAULT_USAGE,
		stopReason: "error",
		errorMessage: formatThrownValue(err),
		timestamp: Date.now(),
	};
}

/**
 *
 */
function abortedMsg(partial: AssistantMessage): AssistantMessage {
	return { ...partial, stopReason: "aborted", errorMessage: "Request was aborted", timestamp: Date.now() };
}

type Stream = ReturnType<typeof createAssistantMessageEventStream>;

/**
 *
 */
async function streamWithDeltas(
	stream: Stream,
	msg: AssistantMessage,
	minTok: number,
	maxTok: number,
	tps: number | undefined,
	signal: AbortSignal | undefined,
): Promise<void> {
	const partial: AssistantMessage = { ...msg, content: [] };
	if (signal?.aborted) {
		const ab = abortedMsg(partial);
		stream.push({ type: "error", reason: "aborted", error: ab });
		stream.end(ab);
		return;
	}
	stream.push({ type: "start", partial: { ...partial } });

	for (let idx = 0; idx < msg.content.length; idx++) {
		if (signal?.aborted) {
			const ab = abortedMsg(partial);
			stream.push({ type: "error", reason: "aborted", error: ab });
			stream.end(ab);
			return;
		}
		const block = msg.content[idx];

		if (block.type === "thinking") {
			partial.content = [...partial.content, { type: "thinking", thinking: "" }];
			stream.push({ type: "thinking_start", contentIndex: idx, partial: { ...partial } });
			for (const chunk of splitByTokenSize(block.thinking, minTok, maxTok)) {
				await scheduleChunk(chunk, tps);
				if (signal?.aborted) {
					const ab = abortedMsg(partial);
					stream.push({ type: "error", reason: "aborted", error: ab });
					stream.end(ab);
					return;
				}
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- assertion safe: we pushed ThinkingContent at content[idx] above
				(partial.content[idx] as ThinkingContent).thinking += chunk;
				stream.push({ type: "thinking_delta", contentIndex: idx, delta: chunk, partial: { ...partial } });
			}
			stream.push({ type: "thinking_end", contentIndex: idx, content: block.thinking, partial: { ...partial } });
			continue;
		}

		if (block.type === "text") {
			partial.content = [...partial.content, { type: "text", text: "" }];
			stream.push({ type: "text_start", contentIndex: idx, partial: { ...partial } });
			for (const chunk of splitByTokenSize(block.text, minTok, maxTok)) {
				await scheduleChunk(chunk, tps);
				if (signal?.aborted) {
					const ab = abortedMsg(partial);
					stream.push({ type: "error", reason: "aborted", error: ab });
					stream.end(ab);
					return;
				}
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- assertion safe: we pushed TextContent at content[idx] above
				(partial.content[idx] as TextContent).text += chunk;
				stream.push({ type: "text_delta", contentIndex: idx, delta: chunk, partial: { ...partial } });
			}
			stream.push({ type: "text_end", contentIndex: idx, content: block.text, partial: { ...partial } });
			continue;
		}

		// toolCall
		partial.content = [...partial.content, { type: "toolCall", id: block.id, name: block.name, arguments: {} }];
		stream.push({ type: "toolcall_start", contentIndex: idx, partial: { ...partial } });
		for (const chunk of splitByTokenSize(JSON.stringify(block.arguments), minTok, maxTok)) {
			await scheduleChunk(chunk, tps);
			if (signal?.aborted) {
				const ab = abortedMsg(partial);
				stream.push({ type: "error", reason: "aborted", error: ab });
				stream.end(ab);
				return;
			}
			stream.push({ type: "toolcall_delta", contentIndex: idx, delta: chunk, partial: { ...partial } });
		}
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- assertion safe: we pushed ToolCall at content[idx] above
		(partial.content[idx] as ToolCall).arguments = block.arguments;
		stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: block, partial: { ...partial } });
	}

	if (msg.stopReason === "error" || msg.stopReason === "aborted") {
		stream.push({ type: "error", reason: msg.stopReason, error: msg });
		stream.end(msg);
		return;
	}
	stream.push({ type: "done", reason: msg.stopReason, message: msg });
	stream.end(msg);
}

/**
 *
 */
export function registerFauxProvider(options: RegisterFauxProviderOptions = {}): FauxProviderRegistration {
	const uuid = (): string =>
		typeof globalThis.crypto.randomUUID === "function"
			? globalThis.crypto.randomUUID()
			// eslint-disable-next-line no-magic-numbers
			: Math.random().toString(36).slice(2);
	const api = options.api ?? `${DEFAULT_API_PREFIX}:${uuid()}`;
	const provider = options.provider ?? DEFAULT_PROVIDER;
	const sourceId = `faux-source:${uuid()}`;
	const minTok = Math.max(1, options.tokenSize?.min ?? DEFAULT_MIN_TOKEN_SIZE);
	const maxTok = Math.max(minTok, options.tokenSize?.max ?? DEFAULT_MAX_TOKEN_SIZE);
	const tps = options.tokensPerSecond;
	const state = { callCount: 0 };
	const promptCache = new Map<string, string>();
	let pendingResponses: FauxResponseStep[] = [];

	const modelDefs = options.models?.length
		? options.models
		: [
				{
					id: DEFAULT_MODEL_ID,
					name: DEFAULT_MODEL_NAME,
					reasoning: false,
					input: ["text", "image"] as ("text" | "image")[],
					contextWindow: 128_000,
					maxTokens: 16_384,
				},
			];

	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- assertion safe: modelDefs always has >= 1 element, guaranteeing non-empty tuple
	const models = modelDefs.map((d) => buildFauxModel(d, api, provider)) as [Model<string>, ...Model<string>[]];

	const streamFn = (requestModel: Model<string>, ctx: Context, opts?: StreamOptions) => {
		const outer = createAssistantMessageEventStream();
		const step = pendingResponses.shift();
		state.callCount++;
		// eslint-disable-next-line @typescript-eslint/no-misused-promises -- async callback in queueMicrotask, errors caught internally
		queueMicrotask(async () => {
			try {
				await opts?.onResponse?.({ status: 200, headers: {} }, requestModel);
				if (!step) {
					let msg = errorMsg(new Error("No more faux responses queued"), api, provider, requestModel.id);
					msg = withUsage(msg, ctx, opts, promptCache);
					outer.push({ type: "error", reason: "error", error: msg });
					outer.end(msg);
					return;
				}
				const resolved = typeof step === "function" ? await step(ctx, opts, state, requestModel) : step;
				let msg = cloneMsg(resolved, api, provider, requestModel.id);
				msg = withUsage(msg, ctx, opts, promptCache);
				await streamWithDeltas(outer, msg, minTok, maxTok, tps, opts?.signal);
			} catch (err) {
				const msg = errorMsg(err, api, provider, requestModel.id);
				outer.push({ type: "error", reason: "error", error: msg });
				outer.end(msg);
			}
		});
		return outer;
	};

	registerApiProvider({ api, stream: streamFn, streamSimple: streamFn }, sourceId);

	function getModel(): Model<string>;
	function getModel(id: string): Model<string> | undefined;
	/**
	 *
	 */
	function getModel(id?: string): Model<string> | undefined {
		if (!id) return models[0];
		return models.find((m) => m.id === id);
	}

	return {
		api,
		models,
		getModel,
		state,
		setResponses(responses) {
			pendingResponses = [...responses];
		},
		appendResponses(responses) {
			pendingResponses.push(...responses);
		},
		getPendingResponseCount() {
			return pendingResponses.length;
		},
		unregister() {
			unregisterApiProviders(sourceId);
		},
	};
}
