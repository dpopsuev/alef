import type {
	ResponseCreateParamsStreaming,
	ResponseInput,
	ResponseStreamEvent,
} from "openai/resources/responses/responses.js";

import { getEnvApiKey } from "../../env-api-keys.js";
import { clampThinkingLevel } from "../../models/llm.js";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
} from "../../types.js";
import {
	appendAssistantMessageDiagnostic,
	createAssistantMessageDiagnostic,
} from "../../utils/diagnostics.js";
import { AssistantMessageEventStream } from "../../utils/event-stream.js";
import { headersToRecord } from "../../utils/headers.js";
import { convertResponsesMessages, processResponsesStream } from "../openai/responses-shared.js";
import { buildBaseOptions } from "../base-options.js";

// --- Extracted helpers ---
import {
	isCodexNonTransportError,
	isRetryableError,
	sleep,
	parseSSE,
	parseErrorResponse,
	mapCodexEvents,
	MAX_RETRIES,
	BASE_DELAY_MS,
} from "./errors.js";
import {
	extractAccountId,
	createCodexRequestId,
	buildSSEHeaders,
	buildWebSocketHeaders,
	resolveCodexUrl,
	resolveCodexWebSocketUrl,
	applyServiceTierPricing,
	resolveCodexServiceTier,
	buildRequestBody,
	CODEX_TOOL_CALL_PROVIDERS,
} from "./request.js";
import type { RequestBody } from "./request.js";
import {
	acquireWebSocket,
	parseWebSocket,
	getOrCreateWebSocketDebugStats,
	recordWebSocketFailure,
	recordWebSocketSseFallback,
	isWebSocketSseFallbackActive,
	closeOpenAICodexWebSocketSessions,
	getOpenAICodexWebSocketDebugStats,
	resetOpenAICodexWebSocketDebugStats,
} from "./websocket.js";
import type {
	CachedWebSocketConnection,
	CachedWebSocketContinuationState,
} from "./websocket.js";

// ============================================================================
// Types
// ============================================================================

export interface OpenAICodexResponsesOptions extends StreamOptions {
	reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
	reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	textVerbosity?: "low" | "medium" | "high";
}

// Re-export public API from extracted modules
export {
	getOpenAICodexWebSocketDebugStats,
	resetOpenAICodexWebSocketDebugStats,
	closeOpenAICodexWebSocketSessions,
} from "./websocket.js";

export type { OpenAICodexWebSocketDebugStats } from "./websocket.js";

// ============================================================================
// Main Stream Function
// ============================================================================

export const streamOpenAICodexResponses: StreamFunction<"openai-codex-responses", OpenAICodexResponsesOptions> = (
	model: Model<"openai-codex-responses">,
	context: Context,
	options?: OpenAICodexResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	void (async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-codex-responses" as Api,
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
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty API key must fall through
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			if (!apiKey) {
				throw new Error(`No API key for provider: ${model.provider}`);
			}

			const accountId = extractAccountId(apiKey);
			let body = buildRequestBody(model, context, options);
			const nextBody = await options?.onPayload?.(body, model);
			if (nextBody !== undefined) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- onPayload callback boundary
				body = nextBody as RequestBody;
			}
			// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty sessionId must fall through
			const websocketRequestId = options?.sessionId || createCodexRequestId();
			const sseHeaders = buildSSEHeaders(model.headers, options?.headers, accountId, apiKey, options?.sessionId);
			const websocketHeaders = buildWebSocketHeaders(
				model.headers,
				options?.headers,
				accountId,
				apiKey,
				websocketRequestId,
			);
			const bodyJson = JSON.stringify(body);
			// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty transport must fall through
			const transport = options?.transport || "auto";
			const websocketDisabledForSession = transport !== "sse" && isWebSocketSseFallbackActive(options?.sessionId);
			if (websocketDisabledForSession) {
				recordWebSocketSseFallback(options?.sessionId);
			}

			if (transport !== "sse" && !websocketDisabledForSession) {
				let websocketStarted = false;
				try {
					await processWebSocketStream(
						resolveCodexWebSocketUrl(model.baseUrl),
						body,
						websocketHeaders,
						output,
						stream,
						model,
						() => {
							websocketStarted = true;
						},
						options,
					);

					if (options?.signal?.aborted) {
						throw new Error("Request was aborted");
					}
					stream.push({
						type: "done",
						// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- stopReason narrowing for event type
						reason: output.stopReason as "stop" | "length" | "toolUse",
						message: output,
					});
					stream.end();
					return;
				} catch (error) {
					const aborted = options?.signal?.aborted;
					if (aborted || isCodexNonTransportError(error)) {
						throw error;
					}
					appendAssistantMessageDiagnostic(
						output,
						createAssistantMessageDiagnostic("provider_transport_failure", error, {
							configuredTransport: transport,
							// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- websocketStarted set via callback, ESLint can't track closure mutation
							fallbackTransport: websocketStarted ? undefined : "sse",
							eventsEmitted: websocketStarted,
							// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- websocketStarted set via callback, ESLint can't track closure mutation
							phase: websocketStarted ? "after_message_stream_start" : "before_message_stream_start",
							requestBytes: new TextEncoder().encode(bodyJson).byteLength,
						}),
					);
					recordWebSocketFailure(options?.sessionId, error);
					// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- websocketStarted set via callback, ESLint can't track closure mutation
					if (websocketStarted) {
						throw error;
					}
					recordWebSocketSseFallback(options?.sessionId);
				}
			}

			// Fetch with retry logic for rate limits and transient errors
			let response: Response | undefined;
			let lastError: Error | undefined;

			for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
				if (options?.signal?.aborted) {
					throw new Error("Request was aborted");
				}

				try {
					response = await fetch(resolveCodexUrl(model.baseUrl), {
						method: "POST",
						headers: sseHeaders,
						body: bodyJson,
						signal: options?.signal,
					});
					await options?.onResponse?.(
						{ status: response.status, headers: headersToRecord(response.headers) },
						model,
					);

					if (response.ok) {
						break;
					}

					const errorText = await response.text();
					if (attempt < MAX_RETRIES && isRetryableError(response.status, errorText)) {
						const delayMs = BASE_DELAY_MS * 2 ** attempt;
						await sleep(delayMs, options?.signal);
						continue;
					}

					// Parse error for friendly message on final attempt or non-retryable error
					const fakeResponse = new Response(errorText, {
						status: response.status,
						statusText: response.statusText,
					});
					const info = await parseErrorResponse(fakeResponse);
					throw new Error(info.friendlyMessage ?? info.message);
				} catch (error) {
					if (error instanceof Error) {
						if (error.name === "AbortError" || error.message === "Request was aborted") {
							throw new Error("Request was aborted");
						}
					}
					lastError = error instanceof Error ? error : new Error(String(error));
					// Network errors are retryable
					if (attempt < MAX_RETRIES && !lastError.message.includes("usage limit")) {
						const delayMs = BASE_DELAY_MS * 2 ** attempt;
						await sleep(delayMs, options?.signal);
						continue;
					}
					throw lastError;
				}
			}

			if (!response?.ok) {
				throw lastError ?? new Error("Failed after retries");
			}

			if (!response.body) {
				throw new Error("No response body");
			}

			stream.push({ type: "start", partial: output });
			await processStream(response, output, stream, model, options);

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- stopReason narrowing for event type
			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				// partialJson is only a streaming scratch buffer; never persist it.
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- stripping streaming scratch property
				delete (block as { partialJson?: string }).partialJson;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimpleOpenAICodexResponses: StreamFunction<"openai-codex-responses", SimpleStreamOptions> = (
	model: Model<"openai-codex-responses">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty API key must fall through
	const apiKey = options?.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = buildBaseOptions(model, options, apiKey);
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	return streamOpenAICodexResponses(model, context, {
		...base,
		reasoningEffort,
	} satisfies OpenAICodexResponsesOptions);
};

// ============================================================================
// Response Processing
// ============================================================================

async function processStream(
	response: Response,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<"openai-codex-responses">,
	options?: OpenAICodexResponsesOptions,
): Promise<void> {
	await processResponsesStream(mapCodexEvents(parseSSE(response)), output, stream, model, {
		serviceTier: options?.serviceTier,
		resolveServiceTier: resolveCodexServiceTier,
		applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
	});
}

// ============================================================================
// WebSocket Continuation
// ============================================================================

function requestBodyWithoutInput(body: RequestBody): RequestBody {
	const { input: _input, previous_response_id: _previousResponseId, ...rest } = body;
	return rest;
}

function responseInputsEqual(a: ResponseInput | undefined, b: ResponseInput | undefined): boolean {
	return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

function requestBodiesMatchExceptInput(a: RequestBody, b: RequestBody): boolean {
	return JSON.stringify(requestBodyWithoutInput(a)) === JSON.stringify(requestBodyWithoutInput(b));
}

function getCachedWebSocketInputDelta(
	body: RequestBody,
	continuation: CachedWebSocketContinuationState,
): ResponseInput | undefined {
	if (!requestBodiesMatchExceptInput(body, continuation.lastRequestBody)) {
		return undefined;
	}

	const currentInput = body.input ?? [];
	const baseline = [...(continuation.lastRequestBody.input ?? []), ...continuation.lastResponseItems];
	if (currentInput.length < baseline.length) {
		return undefined;
	}

	const prefix = currentInput.slice(0, baseline.length);
	if (!responseInputsEqual(prefix, baseline)) {
		return undefined;
	}

	return currentInput.slice(baseline.length);
}

function buildCachedWebSocketRequestBody(entry: CachedWebSocketConnection, body: RequestBody): RequestBody {
	const continuation = entry.continuation;
	if (!continuation) {
		return body;
	}

	const delta = getCachedWebSocketInputDelta(body, continuation);
	if (!delta || !continuation.lastResponseId) {
		entry.continuation = undefined;
		return body;
	}

	return {
		...body,
		previous_response_id: continuation.lastResponseId,
		input: delta,
	};
}

async function* startWebSocketOutputOnFirstEvent(
	events: AsyncIterable<ResponseStreamEvent>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	onStart: () => void,
): AsyncGenerator<ResponseStreamEvent> {
	let started = false;
	for await (const event of events) {
		if (!started) {
			started = true;
			onStart();
			stream.push({ type: "start", partial: output });
		}
		yield event;
	}
}

async function processWebSocketStream(
	url: string,
	body: RequestBody,
	headers: Headers,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<"openai-codex-responses">,
	onStart: () => void,
	options?: OpenAICodexResponsesOptions,
): Promise<void> {
	const { socket, entry, reused, release } = await acquireWebSocket(url, headers, options?.sessionId, options?.signal);
	let keepConnection = true;
	const useCachedContext = options?.transport === "websocket-cached" || options?.transport === "auto";
	// ChatGPT Codex Responses rejects `store: true` ("Store must be set to false").
	// WebSocket continuation still works via connection-scoped previous_response_id state.
	const fullBody = body;
	const requestBody = useCachedContext && entry ? buildCachedWebSocketRequestBody(entry, fullBody) : fullBody;
	const stats = options?.sessionId ? getOrCreateWebSocketDebugStats(options.sessionId) : undefined;
	if (stats) {
		stats.requests++;
		if (reused) stats.connectionsReused++;
		else stats.connectionsCreated++;
		if (useCachedContext) stats.cachedContextRequests++;
		if (requestBody.store === true) stats.storeTrueRequests++;
		stats.lastInputItems = requestBody.input?.length ?? 0;
		if (requestBody.previous_response_id) {
			stats.deltaRequests++;
			stats.lastDeltaInputItems = requestBody.input?.length ?? 0;
			stats.lastPreviousResponseId = requestBody.previous_response_id;
		} else {
			stats.fullContextRequests++;
			stats.lastDeltaInputItems = undefined;
			stats.lastPreviousResponseId = undefined;
		}
	}
	try {
		socket.send(JSON.stringify({ type: "response.create", ...requestBody }));
		await processResponsesStream(
			startWebSocketOutputOnFirstEvent(
				mapCodexEvents(parseWebSocket(socket, options?.signal)),
				output,
				stream,
				onStart,
			),
			output,
			stream,
			model,
			{
				serviceTier: options?.serviceTier,
				resolveServiceTier: resolveCodexServiceTier,
				applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
			},
		);
		if (options?.signal?.aborted) {
			keepConnection = false;
		} else if (useCachedContext && entry && output.responseId) {
			const responseItems = convertResponsesMessages(model, { messages: [output] }, CODEX_TOOL_CALL_PROVIDERS, {
				includeSystemPrompt: false,
			}).filter((item) => item.type !== "function_call_output");
			entry.continuation = {
				lastRequestBody: fullBody,
				lastResponseId: output.responseId,
				lastResponseItems: responseItems,
			};
		}
	} catch (error) {
		if (entry) {
			entry.continuation = undefined;
		}
		keepConnection = false;
		throw error;
	} finally {
		release({ keep: keepConnection });
	}
}
