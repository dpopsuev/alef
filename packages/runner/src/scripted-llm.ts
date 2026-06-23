/**
 * Minimal scripted LLM organ for ALEF_SCRIPTED_REPLIES integration testing.
 *
 * Supports only plain string replies — sufficient for smoke-binary and
 * smoke-tui tests that verify the binary boots and handles one turn.
 *
 * Does NOT import from testkit. For full scripted behaviour with tool calls,
 * use ScriptedReasoner from @dpopsuev/alef-testkit directly in unit tests.
 */

import { randomUUID } from "node:crypto";
import type { Adapter, Bus, ToolDefinition } from "@dpopsuev/alef-kernel";

type SerializedStep =
	| string
	| { kind: "reply"; text: string }
	| { kind: "toolCall"; call: { name: string; args: Record<string, unknown> }; reply: string }
	| { kind: "toolCalls"; calls: Array<{ name: string; args: Record<string, unknown> }>; reply: string };

function toReplyText(step: SerializedStep): string {
	if (typeof step === "string") return step;
	if (step.kind === "reply") return step.text;
	return step.reply;
}

export interface ScriptedLlmOptions {}

export class ScriptedLlmAdapter implements Adapter {
	readonly name = "scripted-llm";
	readonly tools: readonly ToolDefinition[] = [];
	readonly subscriptions = { command: [] as const, event: ["llm.input"] as readonly string[] };
	readonly sources = [] as const;

	private readonly steps: SerializedStep[];
	private index = 0;

	constructor(steps: SerializedStep[], _opts: ScriptedLlmOptions = {}) {
		this.steps = steps;
	}

	mount(bus: Bus): () => void {
		return bus.event.subscribe("llm.input", (event) => {
			void (async () => {
				const step = this.steps[this.index++];
				if (step !== undefined && typeof step === "object" && step.kind === "toolCall") {
					const toolCallId = randomUUID();
					const dotName = step.call.name; // e.g. "tools.describe"
					bus.command.publish({
						type: "llm.tool-start",
						payload: { callId: toolCallId, name: dotName, args: step.call.args },
						correlationId: event.correlationId,
					});
					await new Promise<void>((resolve) => {
						const off = bus.event.subscribe(dotName, (e) => {
							if (e.correlationId === event.correlationId) {
								off();
								resolve();
							}
						});
						bus.command.publish({
							type: dotName,
							payload: { ...step.call.args, toolCallId },
							correlationId: event.correlationId,
						});
					});
					bus.command.publish({
						type: "llm.tool-end",
						payload: { callId: toolCallId, name: step.call.name, ok: true },
						correlationId: event.correlationId,
					});
				}
				const text = step !== undefined ? toReplyText(step) : "(scripted-llm: script exhausted)";
				bus.command.publish({ type: "llm.chunk", payload: { text }, correlationId: event.correlationId });
				bus.command.publish({ type: "llm.response", payload: { text }, correlationId: event.correlationId });
			})();
		});
	}
}
