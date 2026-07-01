import type { ToolDefinition } from "@dpopsuev/alef-kernel/adapter";
import { type EventMessage, Watchdog } from "@dpopsuev/alef-kernel/bus";
import { traceEvent } from "@dpopsuev/alef-kernel/log";

import type { ToolCall } from "./stream-turn.js";

/** Best-effort text extraction for tool-result display pills. */
export function payloadToText(payload: Record<string, unknown>, isError: boolean, errorMessage?: string): string {
	if (isError) return errorMessage ?? JSON.stringify(payload);
	const { _display: _d, toolCallId: _id, isFinal: _f, ...llm } = payload;
	if (typeof llm.content === "string") return llm.content;
	if (typeof llm.text === "string") return llm.text;
	if (typeof llm.markdown === "string") return llm.markdown;
	return JSON.stringify(llm);
}

/** Extract the optional display block (text and MIME type) from a tool-result payload. */
function extractDisplay(payload: Record<string, unknown>): { text: string; mimeType?: string } | undefined {
	const d = payload._display;
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- runtime-guarded access to untyped display block
	if (d !== null && typeof d === "object" && typeof (d as Record<string, unknown>).text === "string") {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- shape validated by guard above
		const block = d as { text: string; mimeType?: string };
		return { text: block.text, mimeType: block.mimeType };
	}
	return undefined;
}

type EventBus = { subscribe: (type: string, handler: (event: EventMessage) => void) => () => void };

const CORRELATION_ID_DISPLAY_LENGTH = 8;
const CHARS_PER_TOKEN = 4;
const STALL_INTERVAL_MS = 5_000;
const LONG_RUNNING_TIMEOUT_MS = 3_600_000;
const TIMEOUT_BUFFER_MS = 10_000;
const LONG_RUNNING_PREFIXES = ["agent.", "orchestration."];

/** Compute the outer wait timeout for a tool call, extending for long-running or explicitly-timed tools. */
function toOuterTimeoutMs(
	toolName: string,
	args: Record<string, unknown>,
	defaultMs: number,
	toolDef?: ToolDefinition,
): number {
	const longRunning = toolDef?.longRunning ?? LONG_RUNNING_PREFIXES.some((p) => toolName.startsWith(p));
	if (longRunning) {
		const parsed = toolDef?.inputSchema.safeParse(args);
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Zod safeParse .data is unknown at type level
		const data = parsed?.success ? (parsed.data as Record<string, unknown>) : args;
		const explicit =
			typeof data.maxMs === "number" ? data.maxMs : typeof data.timeoutMs === "number" ? data.timeoutMs : undefined;
		return (explicit ?? LONG_RUNNING_TIMEOUT_MS) + TIMEOUT_BUFFER_MS;
	}
	const parsed = toolDef?.inputSchema.safeParse(args);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Zod safeParse .data is unknown at type level
	const data = parsed?.success ? (parsed.data as Record<string, unknown>) : args;
	const inner =
		typeof data.timeoutMs === "number" ? data.timeoutMs : typeof data.maxMs === "number" ? data.maxMs : undefined;
	return inner !== undefined ? inner + TIMEOUT_BUFFER_MS : defaultMs;
}

/** Extract a validation error descriptor from a tool-result payload, if present. */
function extractValidationError(payload: Record<string, unknown>): { field: string; message: string } | undefined {
	const v = payload._validationError;
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- shape validated by typeof+in guard
	if (v && typeof v === "object" && "field" in v) return v as { field: string; message: string };
	return undefined;
}

/** Construct an error EventMessage for a failed tool call with elapsed timing. */
function buildErrorSenseEvent(
	motorType: string,
	correlationId: string,
	callId: string,
	err: unknown,
	elapsedMs: number,
): EventMessage {
	const errorMessage = err instanceof Error ? err.message : String(err);
	return {
		type: motorType,
		correlationId,
		payload: { toolCallId: callId },
		isError: true,
		errorMessage,
		timestamp: Date.now(),
		elapsed: elapsedMs,
	};
}

/** Configuration for subscribing to a tool-result event with timeout, abort, and stall detection. */
export interface ToolResultSubscription {
	event: EventBus;
	toolName: string;
	toolCallId: string;
	correlationId: string;
	timeoutMs: number;
	signal?: AbortSignal;
	onChunk?: (text: string) => void;
	onStall?: (info: { elapsedMs: number; lastChunkMs: number }) => void;
	stallIntervalMs?: number;
}

/** Subscribe to the event bus and resolve when the matching tool-result event arrives or timeout/abort fires. */
export function waitForToolResult(sub: ToolResultSubscription): Promise<EventMessage> {
	const {
		event,
		toolName,
		toolCallId,
		correlationId,
		timeoutMs,
		signal,
		onChunk,
		onStall,
		stallIntervalMs: stallMs = STALL_INTERVAL_MS,
	} = sub;
	const subscribedAt = Date.now();
	traceEvent("llm:tool:subscribe", { name: toolName, toolCallId, correlationId: correlationId.slice(0, CORRELATION_ID_DISPLAY_LENGTH) });
	return new Promise((resolve, reject) => {
		const watchdog = onStall
			? new Watchdog(stallMs, () => {
					traceEvent("tool:stall", {
						name: toolName,
						elapsedMs: Date.now() - subscribedAt,
						lastChunkMs: stallMs,
					});
					onStall({ elapsedMs: Date.now() - subscribedAt, lastChunkMs: stallMs });
				})
			: null;
		watchdog?.start();

		const done = (): void => {
			watchdog?.stop();
		};

		// lint-ignore: RAWTIMER hard tool-call deadline; stall detection uses Watchdog above
		const timer = setTimeout(() => {
			done();
			off();
			traceEvent("llm:tool:timeout", { name: toolName, elapsedMs: Date.now() - subscribedAt });
			reject(new Error(`Tool timed out after ${timeoutMs}ms: ${toolName}`));
		}, timeoutMs);

		if (signal) {
			const onAbort = () => {
				clearTimeout(timer);
				done();
				off();
				traceEvent("llm:tool:aborted", { name: toolName, elapsedMs: Date.now() - subscribedAt });
				reject(new Error(`Tool aborted: ${toolName}`));
			};
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}

		const off = event.subscribe(toolName, (event) => {
			if (event.payload.toolCallId === toolCallId && event.correlationId === correlationId) {
				if (event.payload.isFinal === false) {
					watchdog?.reset();
					if (onChunk) {
						const text =
							typeof event.payload.text === "string"
								? event.payload.text
								: typeof event.payload.output === "string"
									? event.payload.output
									: typeof event.payload.content === "string"
										? event.payload.content
										: undefined;
						if (text) onChunk(text);
					}
					return;
				}
				clearTimeout(timer);
				done();
				off();
				traceEvent("llm:tool:resolved", {
					name: toolName,
					elapsedMs: Date.now() - subscribedAt,
					isError: event.isError,
					...(event.isError && event.errorMessage ? { errorMessage: event.errorMessage } : {}),
				});
				resolve(event);
			}
		});
	});
}

type CommandBus = {
	publish: (event: { type: string; payload: Record<string, unknown>; correlationId: string }) => void;
};
type NotificationBus = {
	publish: (event: { type: string; payload: Record<string, unknown>; correlationId: string }) => void;
};

interface DispatchToolsOptions {
	signal?: AbortSignal;
	toolDefs?: ReadonlyMap<string, ToolDefinition>;
	schemaResolver?: (toolName: string) => ToolDefinition | undefined;
	callAbortControllers?: Map<string, AbortController>;
}

/** Publish tool-call commands in parallel and collect all results with timeout and stall detection. */
export async function dispatchTools(
	command: CommandBus,
	signal: NotificationBus,
	event: EventBus,
	correlationId: string,
	toolCalls: ToolCall[],
	toMotorName: (llmName: string) => string,
	timeoutMs: number,
	options: DispatchToolsOptions,
): Promise<EventMessage[]> {
	return Promise.all(
		toolCalls.map((tc) => {
			const motorType = toMotorName(tc.name);
			const startedAt = Date.now();
			const callController = new AbortController();
			if (options.signal) {
				options.signal.addEventListener("abort", () => callController.abort(options.signal?.reason), {
					once: true,
				});
			}
			options.callAbortControllers?.set(tc.id, callController);
			signal.publish({
				type: "llm.tool-start",
				payload: { callId: tc.id, name: motorType, args: tc.args },
				correlationId,
			});
			const outerWaitMs = toOuterTimeoutMs(
				motorType,
				tc.args,
				timeoutMs,
				options.schemaResolver?.(motorType) ?? options.toolDefs?.get(motorType),
			);
			command.publish({ type: motorType, payload: { ...tc.args, toolCallId: tc.id }, correlationId });
			const onChunk = (text: string) =>
				signal.publish({ type: "llm.tool-chunk", payload: { callId: tc.id, text }, correlationId });
			const onStall = (info: { elapsedMs: number; lastChunkMs: number }) =>
				signal.publish({
					type: "llm.tool-stall",
					payload: { callId: tc.id, name: motorType, ...info },
					correlationId,
				});
			return waitForToolResult({
				event,
				toolName: motorType,
				toolCallId: tc.id,
				correlationId,
				timeoutMs: outerWaitMs,
				signal: callController.signal,
				onChunk,
				onStall,
			})
				.then((r) => {
					const validationErr = extractValidationError(r.payload);
					if (validationErr) {
						signal.publish({
							type: "llm.tool-validation-error",
							payload: { callId: tc.id, ...validationErr },
							correlationId,
						});
					}
					const displayBlock = extractDisplay(r.payload);
					const resultText = payloadToText(r.payload, r.isError, r.errorMessage);
					const estimatedTokens = Math.ceil(resultText.length / CHARS_PER_TOKEN);
					signal.publish({
						type: "llm.tool-end",
						payload: {
							callId: tc.id,
							elapsedMs: Date.now() - startedAt,
							ok: !r.isError,
							result: resultText,
							display: displayBlock?.text,
							displayKind: displayBlock?.mimeType,
							estimatedTokens,
						},
						correlationId,
					});
					options.callAbortControllers?.delete(tc.id);
					return r;
				})
				.catch((err: unknown) => {
					const elapsedMs = Date.now() - startedAt;
					const errorMessage = err instanceof Error ? err.message : String(err);
					signal.publish({
						type: "llm.tool-end",
						payload: {
							callId: tc.id,
							elapsedMs,
							ok: false,
							result: errorMessage,
							display: `\u26a0 ${errorMessage}`,
							displayKind: "text/plain",
						},
						correlationId,
					});
					options.callAbortControllers?.delete(tc.id);
					return buildErrorSenseEvent(motorType, correlationId, tc.id, err, elapsedMs);
				});
		}),
	);
}
