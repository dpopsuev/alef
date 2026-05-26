/**
 * ScriptedReasoner — deterministic LLM organ for blueprint testing.
 *
 * Replaces Reasoner in tests. No real API call. Reads from a ScriptStep queue.
 *
 * On each sense/dialog.message:
 *   1. Pops next ScriptStep from the queue
 *   2. Executes tool calls via the real Motor bus (real organ handlers fire)
 *   3. Waits for Sense results (actual file content, shell output, etc.)
 *   4. Publishes motor/dialog.message { text: step.reply }
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
import type { Nerve, Organ, SenseEvent, ToolDefinition } from "@dpopsuev/alef-spine";
import { DIALOG_MESSAGE } from "@dpopsuev/alef-spine";
import type { ScriptStep } from "./script.js";

export interface ScriptedReasonerOptions {
	/**
	 * Sense event type that triggers a reasoning step.
	 * Default: 'dialog.message'. Set to any event for autonomous agents.
	 */
	triggerEvent?: string;
	/** Motor event type published as the reply. Default: same as triggerEvent. */
	replyEvent?: string;
}

export class ScriptedReasoner implements Organ {
	readonly name = "scripted-llm";
	readonly tools: readonly ToolDefinition[] = [];

	private readonly triggerEvent: string;
	private readonly replyEvent: string;
	private readonly queue: ScriptStep[];
	private stepIndex = 0;

	get subscriptions() {
		return {
			motor: [] as const,
			sense: [this.triggerEvent] as readonly string[],
		};
	}

	constructor(script: ScriptStep[] | ScriptStep, opts: ScriptedReasonerOptions = {}) {
		this.queue = Array.isArray(script) ? script : [script];
		this.triggerEvent = opts.triggerEvent ?? DIALOG_MESSAGE;
		this.replyEvent = opts.replyEvent ?? this.triggerEvent;
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
				nerve.motor.publish({
					type: this.replyEvent,
					payload: { text: step.text },
					correlationId: event.correlationId,
				});
				return;
			}

			const calls = step.kind === "toolCall" ? [step.call] : step.calls;
			const replyText = step.reply;

			// Execute tool calls in parallel — same semantics as Reasoner.
			await Promise.all(
				calls.map(async (call) => {
					const toolCallId = randomUUID();
					nerve.motor.publish({
						type: call.name,
						payload: { ...call.args, toolCallId },
						correlationId: event.correlationId,
					});
					await waitForSense(nerve, call.name, toolCallId, event.correlationId);
				}),
			);

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
