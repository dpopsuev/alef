/**
 * ScriptedReasoner — deterministic LLM organ for blueprint testing.
 *
 * Replaces Reasoner in tests. No real API call. Reads from a ScriptStep queue.
 *
 * On each sense/llm.response:
 *   1. Pops next ScriptStep from the queue
 *   2. Executes tool calls via the real Motor bus (real organ handlers fire)
 *   3. Waits for Sense results (actual file content, shell output, etc.)
 *   4. Publishes motor/llm.response { text: step.reply }
 *
 * This means:
 *   - FsOrgan, ShellOrgan, LectorOrgan handlers execute for real
 *   - Tool results are real (file content, shell exit codes, etc.)
 *   - Only the LLM's decision (which tools to call + final text) is scripted
 *   - Tests are deterministic, no API key needed, but organ behaviour is real
 *
 * Extends (replaces) MockReasoner which only supports a single canned reply.
 *
 * Ref: ALE-SPC-17
 */

import { randomUUID } from "node:crypto";
import type { Nerve, Organ, SenseEvent, ToolDefinition } from "@dpopsuev/alef-kernel";

export interface ToolCallStart {
	callId: string;
	name: string;
	args: Record<string, unknown>;
}
export interface ToolCallEnd {
	callId: string;
	elapsedMs: number;
	ok: boolean;
	result?: string;
	display?: string;
	displayKind?: string;
}

function payloadToText(payload: Record<string, unknown>, isError: boolean, errorMessage?: string): string {
	if (isError) return errorMessage ?? JSON.stringify(payload);
	const { _display: _d, toolCallId: _id, isFinal: _f, ...llm } = payload;
	if (typeof llm.content === "string") return llm.content;
	if (typeof llm.text === "string") return llm.text;
	return JSON.stringify(llm);
}

function extractDisplay(payload: Record<string, unknown>): { text: string; mimeType?: string } | undefined {
	const d = payload._display;
	if (d !== null && typeof d === "object" && typeof (d as Record<string, unknown>).text === "string") {
		return d as { text: string; mimeType?: string };
	}
	return undefined;
}

import type { ScriptStep } from "./script.js";

export interface ScriptedReasonerOptions {
	/**
	 * Sense event type that triggers a reasoning step.
	 * Default: 'llm.response'. Set to any event for autonomous agents.
	 */
	triggerEvent?: string;
	/** Motor event type published as the reply. Default: same as triggerEvent. */
	replyEvent?: string;
	/** Called before each tool call motor.publish — mirrors AgentLoopOptions.onToolStart. */
	onToolStart?: (event: ToolCallStart) => void;
	/** Called after each tool sense result — mirrors AgentLoopOptions.onToolEnd. */
	onToolEnd?: (event: ToolCallEnd) => void;
	/**
	 * Called with the reply text before publishing llm.response.
	 * Mirrors AgentLoopOptions.onResponseChunk — delivers text to TUI without
	 * the ScriptedReasoner needing to know about the sink.
	 */
	onResponseChunk?: (chunk: string) => void;
}

export class ScriptedReasoner implements Organ {
	readonly name = "scripted-llm";
	readonly tools: readonly ToolDefinition[] = [];

	private readonly triggerEvent: string;
	private readonly replyEvent: string;
	private readonly queue: ScriptStep[];
	private readonly opts: ScriptedReasonerOptions;
	private stepIndex = 0;

	get subscriptions() {
		return {
			motor: [] as const,
			sense: [this.triggerEvent] as readonly string[],
		};
	}

	constructor(script: ScriptStep[] | ScriptStep, opts: ScriptedReasonerOptions = {}) {
		this.queue = Array.isArray(script) ? script : [script];
		this.triggerEvent = opts.triggerEvent ?? "llm.input";
		this.replyEvent = opts.replyEvent ?? "llm.response";
		this.opts = opts;
	}

	/** Number of script steps remaining. */
	get remaining(): number {
		return this.queue.length - this.stepIndex;
	}

	/** Reset the script position. Useful for multi-test reuse. */
	reset(): void {
		this.stepIndex = 0;
	}

	mount(nerve: Nerve): () => void {
		const off = nerve.sense.subscribe(this.triggerEvent, (event) => {
			void this._handle(nerve, event);
		});
		return off;
	}

	private async _handle(nerve: Nerve, event: SenseEvent): Promise<void> {
		const step = this.queue[this.stepIndex++];

		if (!step) {
			process.stderr.write(
				`[ScriptedReasoner] Script exhausted after ${this.stepIndex - 1} steps. Replying with sentinel.\n`,
			);
			nerve.motor.publish({
				type: this.replyEvent,
				payload: { text: "(ScriptedReasoner: script exhausted)" },
				correlationId: event.correlationId,
			});
			return;
		}

		try {
			if (step.kind === "reply") {
				if (step.text) this.opts.onResponseChunk?.(step.text);
				nerve.motor.publish({
					type: this.replyEvent,
					payload: { text: step.text },
					correlationId: event.correlationId,
				});
				return;
			}

			const calls = step.kind === "toolCall" ? [step.call] : step.calls;
			const replyText = step.reply;

			// Execute tool calls in parallel — same semantics as organ-llm.
			await Promise.all(
				calls.map(async (call) => {
					const toolCallId = randomUUID();
					const startedAt = Date.now();
					this.opts.onToolStart?.({ callId: toolCallId, name: call.name, args: call.args });
					nerve.motor.publish({
						type: call.name,
						payload: { ...call.args, toolCallId },
						correlationId: event.correlationId,
					});
					const result = await waitForSense(nerve, call.name, toolCallId, event.correlationId);
					this.opts.onToolEnd?.({
						callId: toolCallId,
						elapsedMs: Date.now() - startedAt,
						ok: !result.isError,
						result: payloadToText(result.payload, result.isError, result.errorMessage),
						display: extractDisplay(result.payload)?.text,
						displayKind: extractDisplay(result.payload)?.mimeType,
					});
				}),
			);

			// Deliver reply text via onResponseChunk before publishing llm.response.
			if (replyText) this.opts.onResponseChunk?.(replyText);
			nerve.motor.publish({
				type: this.replyEvent,
				payload: { text: replyText },
				correlationId: event.correlationId,
			});
		} catch (err) {
			// Publish error as dialog reply so dialog.send() resolves rather than hanging.
			nerve.motor.publish({
				type: this.replyEvent,
				payload: { text: `(ScriptedReasoner error: ${String(err)})` },
				correlationId: event.correlationId,
			});
		}
	}
}

// ---------------------------------------------------------------------------
// Utility — await a Sense event matching toolCallId + correlationId
// ---------------------------------------------------------------------------

function waitForSense(
	nerve: Nerve,
	eventType: string,
	toolCallId: string,
	correlationId: string,
	timeoutMs = 30_000,
): Promise<SenseEvent> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			off();
			reject(new Error(`ScriptedReasoner: timeout waiting for sense/${eventType} (toolCallId=${toolCallId})`));
		}, timeoutMs);

		const off = nerve.sense.subscribe(eventType, (e: SenseEvent) => {
			if (e.correlationId === correlationId && (e.payload as { toolCallId?: string }).toolCallId === toolCallId) {
				clearTimeout(timer);
				off();
				resolve(e);
			}
		});
	});
}
