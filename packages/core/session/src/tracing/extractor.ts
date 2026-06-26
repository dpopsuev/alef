import type { StorageRecord } from "../contracts/storage.js";

const SCRIPT_REPLY_PREVIEW_CHARS = 80;
const SCRIPT_MESSAGE_PREVIEW_CHARS = 60;

export interface ToolExecution {
	callId: string;
	toolName: string;
	args: Record<string, unknown>;
	result: Record<string, unknown>;
	elapsed: number;
}

export interface TraceStep {
	turn: number;
	correlationId: string;
	userMessage: string;
	llmResponse: Record<string, unknown> | undefined;
	toolExecutions: ToolExecution[];
	finalReply: string;
}

export type SessionTrace = TraceStep[];

export function extractTrace(records: StorageRecord[]): SessionTrace {
	const turnGroups = new Map<string, StorageRecord[]>();
	const turnOrder: string[] = [];

	for (const r of records) {
		if (r.type === "llm.input" && !turnGroups.has(r.correlationId)) {
			turnOrder.push(r.correlationId);
		}
		const group = turnGroups.get(r.correlationId) ?? [];
		group.push(r);
		turnGroups.set(r.correlationId, group);
	}

	const steps: TraceStep[] = [];

	for (let i = 0; i < turnOrder.length; i++) {
		const corrId = turnOrder[i];
		const events = turnGroups.get(corrId) ?? [];

		let userMessage = "";
		let llmResponse: Record<string, unknown> | undefined;
		let finalReply = "";
		const toolCommands = new Map<string, { toolName: string; args: Record<string, unknown>; timestamp: number }>();
		const toolResults = new Map<string, { result: Record<string, unknown>; timestamp: number }>();

		for (const e of events) {
			const bus = e.bus as string;

			if (e.type === "llm.input") {
				userMessage = typeof e.payload.text === "string" ? e.payload.text : "";
			}

			if (e.type === "llm.result" && (bus === "notification" || bus === "sense")) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing untyped event payload field
				const resp = e.payload.response as Record<string, unknown> | undefined;
				if (resp && resp.role === "assistant") {
					llmResponse = resp;
				}
			}

			if (e.type === "llm.response" && (bus === "command" || bus === "motor")) {
				finalReply = typeof e.payload.text === "string" ? e.payload.text : "";
			}

			if ((bus === "command" || bus === "motor") && e.type !== "llm.response" && e.type !== "context.assemble" && e.type !== "llm.checkpoint") {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing untyped event payload field
				const toolCallId = e.payload.toolCallId as string | undefined;
				if (toolCallId) {
					toolCommands.set(toolCallId, {
						toolName: e.type,
						args: { ...e.payload },
						timestamp: e.timestamp,
					});
				}
			}

			if ((bus === "event" || bus === "sense") && e.type !== "llm.input" && e.type !== "context.assemble") {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing untyped event payload field
				const toolCallId = e.payload.toolCallId as string | undefined;
				if (toolCallId) {
					toolResults.set(toolCallId, {
						result: { ...e.payload },
						timestamp: e.timestamp,
					});
				}
			}
		}

		const toolExecutions: ToolExecution[] = [];
		for (const [callId, cmd] of toolCommands) {
			const res = toolResults.get(callId);
			toolExecutions.push({
				callId,
				toolName: cmd.toolName,
				args: cmd.args,
				result: res?.result ?? {},
				elapsed: res ? res.timestamp - cmd.timestamp : 0,
			});
		}

		steps.push({
			turn: i,
			correlationId: corrId,
			userMessage,
			llmResponse,
			toolExecutions,
			finalReply,
		});
	}

	return steps;
}

export function traceToScript(trace: SessionTrace): string {
	const lines: string[] = [];
	for (const step of trace) {
		lines.push(`// Turn ${step.turn}: "${step.userMessage.slice(0, SCRIPT_MESSAGE_PREVIEW_CHARS)}"`);
		if (step.toolExecutions.length > 0) {
			for (const exec of step.toolExecutions) {
				lines.push(`await tools.call("${exec.toolName}", ${JSON.stringify(exec.args)});`);
			}
		}
		if (step.finalReply) {
			lines.push(`// Reply: "${step.finalReply.slice(0, SCRIPT_REPLY_PREVIEW_CHARS)}"`);
		}
		lines.push("");
	}
	return lines.join("\n");
}
