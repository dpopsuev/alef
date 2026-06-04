import type { SenseEvent } from "@dpopsuev/alef-spine";
import { debugLog } from "@dpopsuev/alef-spine";
import type { ToolCall } from "./stream-turn.js";
import type { CerebrumEvent } from "./tool-events.js";

export function payloadToText(payload: Record<string, unknown>, isError: boolean, errorMessage?: string): string {
	if (isError) return errorMessage ?? JSON.stringify(payload);
	const { _display: _d, toolCallId: _id, isFinal: _f, ...llm } = payload;
	if (typeof llm.content === "string") return llm.content;
	if (typeof llm.text === "string") return llm.text;
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

export function waitForToolResult(
	sense: SenseBus,
	toolName: string,
	toolCallId: string,
	correlationId: string,
	timeoutMs: number,
	onChunk?: (text: string) => void,
): Promise<SenseEvent> {
	const subscribedAt = Date.now();
	debugLog("llm:tool:subscribe", { name: toolName, toolCallId, correlationId: correlationId.slice(0, 8) });
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			off();
			debugLog("llm:tool:timeout", { name: toolName, elapsedMs: Date.now() - subscribedAt });
			reject(new Error(`Tool timed out after ${timeoutMs}ms: ${toolName}`));
		}, timeoutMs);
		const off = sense.subscribe(toolName, (event) => {
			if (event.payload.toolCallId === toolCallId && event.correlationId === correlationId) {
				if (event.payload.isFinal === false) {
					// Relay intermediate streaming chunks to the TUI so long-running
					// tools (shell.exec, agent.run) show live progress in the pill.
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

interface DispatchToolsOptions {
	onEvent?: (event: CerebrumEvent) => void;
}

export async function dispatchTools(
	motor: MotorBus,
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
			options.onEvent?.({ type: "tool-start", callId: tc.id, name: motorType, args: tc.args });
			// If the tool call payload declares its own timeoutMs (e.g. agent.run), the
			// outer wait uses that value + 10s headroom so the inner tool can self-terminate
			// before the parent fires its own timeout.
			const innerTimeoutMs = typeof tc.args.timeoutMs === "number" ? tc.args.timeoutMs : undefined;
			const outerWaitMs = innerTimeoutMs !== undefined ? innerTimeoutMs + 10_000 : timeoutMs;
			motor.publish({ type: motorType, payload: { ...tc.args, toolCallId: tc.id }, correlationId });
			const { onEvent } = options;
			const onChunk = onEvent ? (text: string) => onEvent({ type: "tool-chunk", callId: tc.id, text }) : undefined;
			return waitForToolResult(sense, motorType, tc.id, correlationId, outerWaitMs, onChunk)
				.then((r) => {
					const displayBlock = extractDisplay(r.payload);
					options.onEvent?.({
						type: "tool-end",
						callId: tc.id,
						elapsedMs: Date.now() - startedAt,
						ok: !r.isError,
						result: payloadToText(r.payload, r.isError, r.errorMessage),
						display: displayBlock?.text,
						displayKind: displayBlock?.mimeType,
					});
					return r;
				})
				.catch((err: unknown) => {
					// Timeout or other error: emit tool-end so the TUI clears the pill,
					// then return a synthetic error SenseEvent so appendToolResults can
					// add a toolResult to the LLM context (instead of letting the rejection
					// propagate and kill the entire turn).
					const elapsedMs = Date.now() - startedAt;
					const errorMessage = err instanceof Error ? err.message : String(err);
					options.onEvent?.({
						type: "tool-end",
						callId: tc.id,
						elapsedMs,
						ok: false,
						result: errorMessage,
						display: `\u26a0 ${errorMessage}`,
						displayKind: "text/plain",
					});
					return {
						type: motorType,
						correlationId,
						payload: { toolCallId: tc.id },
						isError: true,
						errorMessage,
						timestamp: Date.now(),
						elapsed: elapsedMs,
					} as SenseEvent;
				});
		}),
	);
}
