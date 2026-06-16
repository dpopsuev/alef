import type { SenseEvent, ToolDefinition } from "@dpopsuev/alef-kernel";
import { debugLog, Watchdog } from "@dpopsuev/alef-kernel";

import type { ToolCall } from "./stream-turn.js";

export function payloadToText(payload: Record<string, unknown>, isError: boolean, errorMessage?: string): string {
	if (isError) return errorMessage ?? JSON.stringify(payload);
	const { _display: _d, toolCallId: _id, isFinal: _f, ...llm } = payload;
	if (typeof llm.content === "string") return llm.content;
	if (typeof llm.text === "string") return llm.text;
	if (typeof llm.markdown === "string") return llm.markdown;
	return JSON.stringify(llm);
}

function extractDisplay(payload: Record<string, unknown>): { text: string; mimeType?: string } | undefined {
	const d = payload._display;
	if (d !== null && typeof d === "object" && typeof (d as Record<string, unknown>).text === "string") {
		const block = d as { text: string; mimeType?: string };
		return { text: block.text, mimeType: block.mimeType };
	}
	return undefined;
}

type SenseBus = { subscribe: (type: string, handler: (event: SenseEvent) => void) => () => void };

const STALL_INTERVAL_MS = 5_000;

const LONG_RUNNING_TIMEOUT_MS = 3_600_000;

function toOuterTimeoutMs(args: Record<string, unknown>, defaultMs: number, toolDef?: ToolDefinition): number {
	if (toolDef?.longRunning) {
		const parsed = toolDef.inputSchema.safeParse(args);
		const data = parsed?.success ? (parsed.data as Record<string, unknown>) : args;
		const explicit =
			typeof data.maxMs === "number" ? data.maxMs : typeof data.timeoutMs === "number" ? data.timeoutMs : undefined;
		return (explicit ?? LONG_RUNNING_TIMEOUT_MS) + 10_000;
	}
	const parsed = toolDef?.inputSchema.safeParse(args);
	const data = parsed?.success ? (parsed.data as Record<string, unknown>) : args;
	const inner =
		typeof data.timeoutMs === "number" ? data.timeoutMs : typeof data.maxMs === "number" ? data.maxMs : undefined;
	return inner !== undefined ? inner + 10_000 : defaultMs;
}

function extractValidationError(payload: Record<string, unknown>): { field: string; message: string } | undefined {
	const v = payload._validationError;
	if (v && typeof v === "object" && "field" in v) return v as { field: string; message: string };
	return undefined;
}

function buildErrorSenseEvent(
	motorType: string,
	correlationId: string,
	callId: string,
	err: unknown,
	elapsedMs: number,
): SenseEvent {
	const errorMessage = err instanceof Error ? err.message : String(err);
	return {
		type: motorType,
		correlationId,
		payload: { toolCallId: callId },
		isError: true,
		errorMessage,
		timestamp: Date.now(),
		elapsed: elapsedMs,
	} as SenseEvent;
}

export interface ToolResultSubscription {
	sense: SenseBus;
	toolName: string;
	toolCallId: string;
	correlationId: string;
	timeoutMs: number;
	onChunk?: (text: string) => void;
	onStall?: (info: { elapsedMs: number; lastChunkMs: number }) => void;
	stallIntervalMs?: number;
}

export function waitForToolResult(sub: ToolResultSubscription): Promise<SenseEvent> {
	const {
		sense,
		toolName,
		toolCallId,
		correlationId,
		timeoutMs,
		onChunk,
		onStall,
		stallIntervalMs: stallMs = STALL_INTERVAL_MS,
	} = sub;
	const subscribedAt = Date.now();
	debugLog("llm:tool:subscribe", { name: toolName, toolCallId, correlationId: correlationId.slice(0, 8) });
	return new Promise((resolve, reject) => {
		const watchdog = onStall
			? new Watchdog(stallMs, () => {
					debugLog("tool:stall", {
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
			debugLog("llm:tool:timeout", { name: toolName, elapsedMs: Date.now() - subscribedAt });
			reject(new Error(`Tool timed out after ${timeoutMs}ms: ${toolName}`));
		}, timeoutMs);
		const off = sense.subscribe(toolName, (event) => {
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
				debugLog("llm:tool:resolved", {
					name: toolName,
					elapsedMs: Date.now() - subscribedAt,
					isError: event.isError,
				});
				resolve(event);
			}
		});
	});
}

type MotorBus = { publish: (event: { type: string; payload: Record<string, unknown>; correlationId: string }) => void };
type SignalBus = {
	publish: (event: { type: string; payload: Record<string, unknown>; correlationId: string }) => void;
};

interface DispatchToolsOptions {
	toolDefs?: ReadonlyMap<string, ToolDefinition>;
	schemaResolver?: (toolName: string) => ToolDefinition | undefined;
}

export async function dispatchTools(
	motor: MotorBus,
	signal: SignalBus,
	sense: SenseBus,
	correlationId: string,
	toolCalls: ToolCall[],
	toMotorName: (llmName: string) => string,
	timeoutMs: number,
	options: DispatchToolsOptions,
): Promise<SenseEvent[]> {
	return Promise.all(
		toolCalls.map((tc) => {
			const motorType = toMotorName(tc.name);
			const startedAt = Date.now();
			signal.publish({
				type: "llm.tool-start",
				payload: { callId: tc.id, name: motorType, args: tc.args },
				correlationId,
			});
			const outerWaitMs = toOuterTimeoutMs(
				tc.args,
				timeoutMs,
				options.schemaResolver?.(motorType) ?? options.toolDefs?.get(motorType),
			);
			motor.publish({ type: motorType, payload: { ...tc.args, toolCallId: tc.id }, correlationId });
			const onChunk = (text: string) =>
				signal.publish({ type: "llm.tool-chunk", payload: { callId: tc.id, text }, correlationId });
			const onStall = (info: { elapsedMs: number; lastChunkMs: number }) =>
				signal.publish({
					type: "llm.tool-stall",
					payload: { callId: tc.id, name: motorType, ...info },
					correlationId,
				});
			return waitForToolResult({
				sense,
				toolName: motorType,
				toolCallId: tc.id,
				correlationId,
				timeoutMs: outerWaitMs,
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
					signal.publish({
						type: "llm.tool-end",
						payload: {
							callId: tc.id,
							elapsedMs: Date.now() - startedAt,
							ok: !r.isError,
							result: payloadToText(r.payload, r.isError, r.errorMessage),
							display: displayBlock?.text,
							displayKind: displayBlock?.mimeType,
						},
						correlationId,
					});
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
					return buildErrorSenseEvent(motorType, correlationId, tc.id, err, elapsedMs);
				});
		}),
	);
}
