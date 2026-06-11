/**
 * Minimal scripted LLM organ for ALEF_SCRIPTED_REPLIES integration testing.
 *
 * Supports only plain string replies — sufficient for smoke-binary and
 * smoke-tui tests that verify the binary boots and handles one turn.
 *
 * Does NOT import from testkit. For full scripted behaviour with tool calls,
 * use ScriptedReasoner from @dpopsuev/alef-testkit directly in unit tests.
 */

import type { Nerve, Organ, ToolDefinition } from "@dpopsuev/alef-kernel";

import type { LlmEvent } from "@dpopsuev/alef-organ-llm";

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

export interface ScriptedLlmOptions {
	onEvent?: (event: LlmEvent) => void;
}

export class ScriptedLlmOrgan implements Organ {
	readonly name = "scripted-llm";
	readonly tools: readonly ToolDefinition[] = [];
	readonly subscriptions = { motor: [] as const, sense: ["llm.input"] as readonly string[] };

	private readonly steps: SerializedStep[];
	private readonly opts: ScriptedLlmOptions;
	private index = 0;

	constructor(steps: SerializedStep[], opts: ScriptedLlmOptions = {}) {
		this.steps = steps;
		this.opts = opts;
	}

	mount(nerve: Nerve): () => void {
		return nerve.sense.subscribe("llm.input", (event) => {
			const step = this.steps[this.index++];
			const text = step !== undefined ? toReplyText(step) : "(scripted-llm: script exhausted)";
			this.opts.onEvent?.({ type: "chunk", text });
			nerve.motor.publish({
				type: "llm.response",
				payload: { text },
				correlationId: event.correlationId,
			});
		});
	}
}
