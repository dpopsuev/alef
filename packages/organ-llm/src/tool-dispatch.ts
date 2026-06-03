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
				if (event.payload.isFinal === false) return;
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
			motor.publish({ type: motorType, payload: { ...tc.args, toolCallId: tc.id }, correlationId });
			return waitForToolResult(sense, motorType, tc.id, correlationId, timeoutMs).then((r) => {
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
			});
		}),
	);
}
