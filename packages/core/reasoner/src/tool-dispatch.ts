import type { ToolDefinition } from "@dpopsuev/alef-kernel/adapter";
import type { EventMessage } from "@dpopsuev/alef-kernel/bus";
import { traceEvent } from "@dpopsuev/alef-kernel/log";

import type { ToolCall } from "./stream-turn.js";
import { classifyToolError, formatToolErrorObservation } from "./tool-error-observation.js";

/** Best-effort text extraction for tool-result display pills. */
export function payloadToText(
	payload: Record<string, unknown>,
	isError: boolean,
	errorMessage?: string,
	toolName?: string,
): string {
	if (isError) {
		const message = errorMessage ?? (typeof payload.errorMessage === "string" ? payload.errorMessage : undefined);
		const observation = classifyToolError(message ?? JSON.stringify(payload), {
			tool: toolName ?? (typeof payload.tool === "string" ? payload.tool : undefined),
			payload,
		});
		return formatToolErrorObservation(observation);
	}
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
const MILLISECONDS_PER_SECOND = 1_000;
const LONG_RUNNING_TIMEOUT_MS = 3_600_000;
const LONG_RUNNING_PREFIXES = ["agent.", "orchestration."];
const MIN_SUPERVISION_WAKE_MS = 1_000;
const MIN_SUPERVISION_STALL_MS = 2_000;
const DEFAULT_HEARTBEAT_GRACE_MS = 20_000;
const DEFAULT_WAKE_EXTENSION_MS = 60_000;
const STANDARD_WAKE_CAP_MS = 30_000;
const LONG_RUNNING_WAKE_RATIO = 0.2;
const STANDARD_WAKE_RATIO = 0.5;
const STALL_AFTER_WAKE_MULTIPLIER = 1.5;
const OUTPUT_TAIL_MAX_CHARS = 4_000;
const SUPERVISION_TIMER_MIN_MS = 50;
const SUPERVISION_TIMER_DIVISOR = 4;
const CANCEL_FALLBACK_ABORT_DELAY_MS = 1_000;

/**
 * Explicit tool deadline from call args.
 * `timeoutMs` / `maxMs` are milliseconds; `timeout` is seconds (shell.exec / nodesh).
 */
export function explicitToolTimeoutMs(args: Record<string, unknown>): number | undefined {
	if (typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs) && args.timeoutMs >= 0) {
		return args.timeoutMs;
	}
	if (typeof args.maxMs === "number" && Number.isFinite(args.maxMs) && args.maxMs >= 0) {
		return args.maxMs;
	}
	if (typeof args.timeout === "number" && Number.isFinite(args.timeout) && args.timeout >= 0) {
		return args.timeout * MILLISECONDS_PER_SECOND;
	}
	return undefined;
}

/** Ownership split between adapter execution caps and reasoner supervision patience. */
export interface ToolSupervisionPolicy {
	expectedRuntimeMs: number;
	wakeAfterMs: number;
	stallAfterMs: number;
	heartbeatGraceMs: number;
	allowInfiniteWait: boolean;
	suggestedActions: Array<"wait" | "inspect" | "cancel" | "extend">;
}

/** Snapshot of the latest known progress for a tool call. */
export interface ToolProgressSnapshot {
	callId: string;
	name: string;
	elapsedMs: number;
	outputTail?: string;
	lastOutputMs?: number;
	processAlive?: boolean;
	cpuActive?: boolean;
	classification?: string;
}

/** Wake-up payload sent to the supervisor when patience expires. */
export interface ToolWakeSnapshot extends ToolProgressSnapshot {
	reason: "slow" | "stall" | "protocol";
	availableActions: Array<"wait" | "inspect" | "cancel" | "extend">;
}

/** Decision returned by the supervision handler. */
export interface ToolWakeDecision {
	action: "wait" | "cancel" | "extend";
	extendMs?: number;
}

/**
 *
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
	return hasTruthyRecord(value) ? value : undefined;
}

/**
 *
 */
function hasTruthyRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 *
 */
function appendTail(current: string, next: string | undefined): string {
	if (!next) return current;
	const combined = current ? `${current}${next}` : next;
	return combined.length > OUTPUT_TAIL_MAX_CHARS ? combined.slice(-OUTPUT_TAIL_MAX_CHARS) : combined;
}

/**
 *
 */
function extractPartialText(payload: Record<string, unknown>): string | undefined {
	if (typeof payload.text === "string") return payload.text;
	if (typeof payload.chunk === "string") return payload.chunk;
	if (typeof payload.outputTail === "string") return payload.outputTail;
	if (typeof payload.output === "string") return payload.output;
	if (typeof payload.content === "string") return payload.content;
	return undefined;
}

/**
 *
 */
function toolHasHeartbeat(toolName: string, args: Record<string, unknown>, toolDef?: ToolDefinition): boolean {
	if (toolName === "shell.exec") return true;
	if (toolDef?.streaming) return Boolean(toolDef.longRunning);
	if (args.block_until_ms === 0) return true;
	return false;
}

/**
 *
 */
function isBackgroundLike(args: Record<string, unknown>): boolean {
	return args.block_until_ms === 0 || hasTruthyRecord(args.notify_on_output);
}

/** Compute the reasoner's patience policy for a tool call without owning the kill switch. */
export function resolveToolSupervisionPolicy(
	toolName: string,
	args: Record<string, unknown>,
	defaultMs: number,
	toolDef?: ToolDefinition,
): ToolSupervisionPolicy {
	const longRunning = toolDef?.longRunning ?? LONG_RUNNING_PREFIXES.some((prefix) => toolName.startsWith(prefix));
	const parsed = toolDef?.inputSchema.safeParse(args);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Zod safeParse .data is unknown at type level
	const data = parsed?.success ? (parsed.data as Record<string, unknown>) : args;
	const explicitRuntimeMs = explicitToolTimeoutMs(data);
	const backgroundLike = isBackgroundLike(data);
	const allowInfiniteWait = longRunning || backgroundLike || toolName === "shell.exec";
	const expectedRuntimeMs = explicitRuntimeMs ?? (allowInfiniteWait ? LONG_RUNNING_TIMEOUT_MS : defaultMs);
	const wakeAfterMs = allowInfiniteWait
		? Math.min(
				DEFAULT_WAKE_EXTENSION_MS,
				Math.max(MIN_SUPERVISION_WAKE_MS, Math.floor(expectedRuntimeMs * LONG_RUNNING_WAKE_RATIO)),
			)
		: Math.min(STANDARD_WAKE_CAP_MS, Math.max(MIN_SUPERVISION_WAKE_MS, Math.floor(expectedRuntimeMs * STANDARD_WAKE_RATIO)));
	const stallAfterMs = allowInfiniteWait
		? Math.max(MIN_SUPERVISION_STALL_MS, wakeAfterMs)
		: Math.max(MIN_SUPERVISION_STALL_MS, Math.floor(wakeAfterMs * STALL_AFTER_WAKE_MULTIPLIER));
	const heartbeatGraceMs = toolHasHeartbeat(toolName, data, toolDef)
		? Math.max(MIN_SUPERVISION_WAKE_MS, Math.min(DEFAULT_HEARTBEAT_GRACE_MS, wakeAfterMs))
		: Math.max(stallAfterMs, wakeAfterMs);
	return {
		expectedRuntimeMs,
		wakeAfterMs,
		stallAfterMs,
		heartbeatGraceMs,
		allowInfiniteWait,
		suggestedActions: ["wait", "inspect", "cancel", "extend"],
	};
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
	supervision: ToolSupervisionPolicy;
	needsHeartbeat?: boolean;
	signal?: AbortSignal;
	onChunk?: (text: string) => void;
	onProgress?: (snapshot: ToolProgressSnapshot) => void;
	onHeartbeat?: (snapshot: ToolProgressSnapshot) => void;
	onStall?: (info: { elapsedMs: number; lastChunkMs: number }) => void;
	onWake?: (snapshot: ToolWakeSnapshot) => Promise<ToolWakeDecision | void> | ToolWakeDecision | void;
	onBudgetExtended?: (info: { extendMs: number; wakeAfterMs: number }) => void;
}

/**
 *
 */
function isHeartbeatPayload(payload: Record<string, unknown>): boolean {
	return Boolean(payload.heartbeat) || typeof payload.classification === "string";
}

/** Subscribe to the event bus and resolve when the matching tool-result event arrives or supervision ends it. */
export function waitForToolResult(sub: ToolResultSubscription): Promise<EventMessage> {
	const {
		event,
		toolName,
		toolCallId,
		correlationId,
		supervision,
		needsHeartbeat = false,
		signal,
		onChunk,
		onProgress,
		onHeartbeat,
		onStall,
		onWake,
		onBudgetExtended,
	} = sub;
	const subscribedAt = Date.now();
	traceEvent("llm:tool:subscribe", { name: toolName, toolCallId, correlationId: correlationId.slice(0, CORRELATION_ID_DISPLAY_LENGTH) });
	return new Promise((resolve, reject) => {
		let latestOutputTail = "";
		let latestOutputAt: number | undefined;
		let latestClassification: string | undefined;
		let processAlive: boolean | undefined;
		let cpuActive: boolean | undefined;
		let lastActivityAt = subscribedAt;
		let lastHeartbeatAt: number | undefined;
		let slowWakeAfterMs = supervision.wakeAfterMs;
		let wakeInFlight = false;
		let settled = false;
		let off: () => void = () => {};

		const snapshot = (elapsedMs: number): ToolProgressSnapshot => ({
			callId: toolCallId,
			name: toolName,
			elapsedMs,
			...(latestOutputTail ? { outputTail: latestOutputTail } : {}),
			...(latestOutputAt !== undefined ? { lastOutputMs: elapsedMs - (Date.now() - latestOutputAt) } : {}),
			...(processAlive !== undefined ? { processAlive } : {}),
			...(cpuActive !== undefined ? { cpuActive } : {}),
			...(latestClassification ? { classification: latestClassification } : {}),
		});

		const settle = (handler: () => void): void => {
			if (settled) return;
			settled = true;
			clearInterval(supervisionTimer);
			off();
			handler();
		};

		if (signal) {
			const onAbort = () => {
				settle(() => {
					traceEvent("llm:tool:aborted", { name: toolName, elapsedMs: Date.now() - subscribedAt });
					reject(new Error(`Tool aborted: ${toolName}`));
				});
			};
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}

		const supervisionTimer = setInterval(() => {
			if (settled || wakeInFlight) return;
			const now = Date.now();
			const elapsedMs = now - subscribedAt;
			const quietMs = now - lastActivityAt;
			const missingHeartbeatMs = lastHeartbeatAt === undefined ? elapsedMs : now - lastHeartbeatAt;
			let reason: ToolWakeSnapshot["reason"] | undefined;
			if (needsHeartbeat && lastHeartbeatAt === undefined && elapsedMs >= supervision.heartbeatGraceMs) {
				reason = "protocol";
			} else if (quietMs >= supervision.stallAfterMs) {
				reason = "stall";
			} else if (elapsedMs >= slowWakeAfterMs) {
				reason = "slow";
			}
			if (!reason) return;
			if (reason === "stall") {
				traceEvent("tool:stall", { name: toolName, elapsedMs, lastChunkMs: quietMs });
				onStall?.({ elapsedMs, lastChunkMs: quietMs });
			}
			if (reason === "protocol" && missingHeartbeatMs >= supervision.heartbeatGraceMs && !onWake) {
				settle(() => reject(new Error(`Tool failed to establish heartbeat: ${toolName}`)));
				return;
			}
			if (!onWake) {
				slowWakeAfterMs += supervision.wakeAfterMs;
				return;
			}
			wakeInFlight = true;
			const wakeSnapshot: ToolWakeSnapshot = {
				...snapshot(elapsedMs),
				reason,
				availableActions: supervision.suggestedActions,
			};
			void Promise.resolve(onWake(wakeSnapshot))
				.then((decision) => {
					if (settled) return;
					if (decision?.action === "extend") {
						const extendMs = Math.max(MIN_SUPERVISION_WAKE_MS, decision.extendMs ?? DEFAULT_WAKE_EXTENSION_MS);
						slowWakeAfterMs = Math.max(slowWakeAfterMs, elapsedMs) + extendMs;
						onBudgetExtended?.({ extendMs, wakeAfterMs: slowWakeAfterMs });
						return;
					}
					if (decision?.action === "wait") {
						slowWakeAfterMs = Math.max(slowWakeAfterMs, elapsedMs) + supervision.wakeAfterMs;
					}
				})
				.finally(() => {
					wakeInFlight = false;
				});
		}, Math.max(
			SUPERVISION_TIMER_MIN_MS,
			Math.min(
				MIN_SUPERVISION_WAKE_MS,
				Math.floor(Math.min(supervision.wakeAfterMs, supervision.stallAfterMs) / SUPERVISION_TIMER_DIVISOR),
			),
		));

		off = event.subscribe(toolName, (event) => {
			if (event.payload.toolCallId === toolCallId && event.correlationId === correlationId) {
				if (event.payload.isFinal === false) {
					const now = Date.now();
					const text = extractPartialText(event.payload);
					if (text) {
						latestOutputTail = appendTail(latestOutputTail, text);
						latestOutputAt = now;
						lastActivityAt = now;
						onChunk?.(text);
					}
					const heartbeat = asRecord(event.payload.heartbeat);
					if (isHeartbeatPayload(event.payload) || heartbeat) {
						lastHeartbeatAt = now;
						processAlive =
							typeof event.payload.processAlive === "boolean"
								? event.payload.processAlive
								: typeof heartbeat?.processAlive === "boolean"
									? (heartbeat.processAlive)
									: processAlive;
						cpuActive =
							typeof event.payload.cpuActive === "boolean"
								? event.payload.cpuActive
								: typeof heartbeat?.cpuActive === "boolean"
									? (heartbeat.cpuActive)
									: cpuActive;
						latestClassification =
							typeof event.payload.classification === "string"
								? event.payload.classification
								: typeof heartbeat?.classification === "string"
									? (heartbeat.classification)
									: latestClassification;
						if (latestClassification === "output-progress" || latestClassification === "cpu-active") {
							lastActivityAt = now;
						}
						onHeartbeat?.(snapshot(now - subscribedAt));
					}
					onProgress?.(snapshot(now - subscribedAt));
					return;
				}
				settle(() => {
					traceEvent("llm:tool:resolved", {
						name: toolName,
						elapsedMs: Date.now() - subscribedAt,
						isError: event.isError,
						...(event.isError && event.errorMessage ? { errorMessage: event.errorMessage } : {}),
					});
					resolve(event);
				});
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
	onToolWake?: (info: ToolWakeSnapshot & { args: Record<string, unknown> }) => Promise<ToolWakeDecision>;
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
			let cancelFallbackTimer: ReturnType<typeof setTimeout> | undefined;
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
			const toolDef = options.schemaResolver?.(motorType) ?? options.toolDefs?.get(motorType);
			const supervision = resolveToolSupervisionPolicy(motorType, tc.args, timeoutMs, toolDef);
			const onChunk = (text: string) =>
				signal.publish({ type: "llm.tool-chunk", payload: { callId: tc.id, text }, correlationId });
			const onStall = (info: { elapsedMs: number; lastChunkMs: number }) =>
				signal.publish({
					type: "llm.tool-stall",
					payload: { callId: tc.id, name: motorType, ...info },
					correlationId,
				});
			const onProgress = (progress: ToolProgressSnapshot) =>
				signal.publish({ type: "llm.tool-progress", payload: { ...progress }, correlationId });
			const onHeartbeat = (heartbeat: ToolProgressSnapshot) =>
				signal.publish({ type: "llm.tool-heartbeat", payload: { ...heartbeat }, correlationId });
			const onBudgetExtended = (info: { extendMs: number; wakeAfterMs: number }) =>
				signal.publish({
					type: "llm.tool-budget-extended",
					payload: { callId: tc.id, name: motorType, ...info },
					correlationId,
				});
			// Register the result waiter before publishing so sync handlers cannot race past the subscribe.
			const resultPromise = waitForToolResult({
				event,
				toolName: motorType,
				toolCallId: tc.id,
				correlationId,
				supervision,
				needsHeartbeat: toolHasHeartbeat(motorType, tc.args, toolDef),
				signal: callController.signal,
				onChunk,
				onProgress,
				onHeartbeat,
				onStall,
				onBudgetExtended,
				onWake: async (wake) => {
					signal.publish({
						type: "llm.tool-wake",
						payload: { ...wake },
						correlationId,
					});
					const decision = await options.onToolWake?.({ ...wake, args: tc.args });
					if (decision?.action === "cancel") {
						signal.publish({ type: "tools.cancel-request", payload: { callId: tc.id }, correlationId });
						// lint-ignore: RAWTIMER adapter gets first chance to honour cancel before waiter falls back
						cancelFallbackTimer = setTimeout(() => {
							callController.abort(new Error(`Cancelled after tool wake: ${motorType}`));
						}, CANCEL_FALLBACK_ABORT_DELAY_MS);
						return decision;
					}
					return decision ?? { action: "wait" };
				},
			});
			command.publish({ type: motorType, payload: { ...tc.args, toolCallId: tc.id }, correlationId });
			return resultPromise
				.then((r) => {
					if (cancelFallbackTimer) clearTimeout(cancelFallbackTimer);
					const validationErr = extractValidationError(r.payload);
					if (validationErr) {
						signal.publish({
							type: "llm.tool-validation-error",
							payload: { callId: tc.id, ...validationErr },
							correlationId,
						});
					}
					const displayBlock = extractDisplay(r.payload);
					const resultText = payloadToText(r.payload, r.isError, r.errorMessage, tc.name);
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
					if (cancelFallbackTimer) clearTimeout(cancelFallbackTimer);
					callController.abort(err instanceof Error ? err : new Error(String(err)));
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
