/**
 * ScriptedReasoner — deterministic LLM adapter for blueprint testing.
 *
 * Replaces Reasoner in tests. No real API call. Reads from a ScriptStep queue.
 *
 * On each event/llm.response:
 * 1. Pops next ScriptStep from the queue
 * 2. Executes tool calls via the real Command bus (real adapter handlers fire)
 * 3. Waits for Event results (actual file content, shell output, etc.)
 * 4. Publishes command/llm.response { text: step.reply }
 *
 * This means:
 * - FsAdapter, ShellAdapter, LectorAdapter handlers execute for real
 * - Tool results are real (file content, shell exit codes, etc.)
 * - Only the LLM's decision (which tools to call + final text) is scripted
 * - Tests are deterministic, no API key needed, but adapter behaviour is real
 *
 * Extends (replaces) MockReasoner which only supports a single canned reply.
 *
 */

import { randomUUID } from "node:crypto";
import type { Adapter, ToolDefinition } from "@dpopsuev/alef-kernel/adapter";
import type { Bus, EventMessage } from "@dpopsuev/alef-kernel/bus";

/**
 *
 */
export interface ToolCallStart {
	callId: string;
	name: string;
	args: Record<string, unknown>;
}
/**
 *
 */
export interface ToolCallEnd {
	callId: string;
	elapsedMs: number;
	ok: boolean;
	result?: string;
	display?: string;
	displayKind?: string;
}

/**
 *
 */
function payloadToText(payload: Record<string, unknown>, isError: boolean, errorMessage?: string): string {
	if (isError) return errorMessage ?? JSON.stringify(payload);
	const { _display: _d, toolCallId: _id, isFinal: _f, ...llm } = payload;
	if (typeof llm.content === "string") return llm.content;
	if (typeof llm.text === "string") return llm.text;
	return JSON.stringify(llm);
}

/**
 *
 */
function extractDisplay(payload: Record<string, unknown>): { text: string; mimeType?: string } | undefined {
	const d = payload._display;
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing unknown _display to check .text property
	if (d !== null && typeof d === "object" && typeof (d as Record<string, unknown>).text === "string") {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- validated above: d has .text string
		return d as { text: string; mimeType?: string };
	}
	return undefined;
}

import type { ScriptStep } from "./script.js";

/**
 *
 */
export interface ScriptedReasonerOptions {
	/**
	 * Event type that triggers a reasoning step.
	 * Default: 'llm.response'. Set to any event for autonomous agents.
	 */
	triggerEvent?: string;
	/** Command event type published as the reply. Default: same as triggerEvent. */
	replyEvent?: string;
	/** Called before each tool call command.publish — mirrors AgentLoopOptions.onToolStart. */
	onToolStart?: (event: ToolCallStart) => void;
	/** Called after each tool event result — mirrors AgentLoopOptions.onToolEnd. */
	onToolEnd?: (event: ToolCallEnd) => void;
	/**
	 * Called with the reply text before publishing llm.response.
	 * Mirrors AgentLoopOptions.onResponseChunk — delivers text to TUI without
	 * the ScriptedReasoner needing to know about the sink.
	 */
	onResponseChunk?: (chunk: string) => void;
}

/**
 *
 */
export class ScriptedReasoner implements Adapter {
	readonly name = "scripted-llm";
	readonly tools: readonly ToolDefinition[] = [];
	readonly sources = [] as const;

	private readonly triggerEvent: string;
	private readonly replyEvent: string;
	private readonly queue: ScriptStep[];
	private readonly opts: ScriptedReasonerOptions;
	private stepIndex = 0;

	get subscriptions() {
		return {
			command: [] as const,
			event: [this.triggerEvent] as readonly string[],
			notification: [] as const,
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

	mount(bus: Bus): () => void {
		const off = bus.event.subscribe(this.triggerEvent, (event) => {
			void this._handle(bus, event);
		});
		return off;
	}

	private async _handle(bus: Bus, event: EventMessage): Promise<void> {
		const step = this.queue[this.stepIndex++];

		if (!step) {
			process.stderr.write(
				`[ScriptedReasoner] Script exhausted after ${this.stepIndex - 1} steps. Replying with sentinel.\n`,
			);
			bus.command.publish({
				type: this.replyEvent,
				payload: { text: "(ScriptedReasoner: script exhausted)" },
				correlationId: event.correlationId,
			});
			return;
		}

		try {
			if (step.kind === "reply") {
				if (step.text) this.opts.onResponseChunk?.(step.text);
				bus.command.publish({
					type: this.replyEvent,
					payload: { text: step.text },
					correlationId: event.correlationId,
				});
				return;
			}

			const calls = step.kind === "toolCall" ? [step.call] : step.calls;
			const replyText = step.reply;

			// Execute tool calls in parallel — same semantics as adapter-llm.
			await Promise.all(
				calls.map(async (call) => {
					const toolCallId = randomUUID();
					const startedAt = Date.now();
					this.opts.onToolStart?.({ callId: toolCallId, name: call.name, args: call.args });
					bus.command.publish({
						type: call.name,
						payload: { ...call.args, toolCallId },
						correlationId: event.correlationId,
					});
					const result = await waitForEvent(bus, call.name, toolCallId, event.correlationId);
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
			bus.command.publish({
				type: this.replyEvent,
				payload: { text: replyText },
				correlationId: event.correlationId,
			});
		} catch (err) {
			// Publish error as dialog reply so dialog.send() resolves rather than hanging.
			bus.command.publish({
				type: this.replyEvent,
				payload: { text: `(ScriptedReasoner error: ${String(err)})` },
				correlationId: event.correlationId,
			});
		}
	}
}

// ---------------------------------------------------------------------------
// Utility — await an Event matching toolCallId + correlationId
// ---------------------------------------------------------------------------

/**
 *
 */
function waitForEvent(
	bus: Bus,
	eventType: string,
	toolCallId: string,
	correlationId: string,
	timeoutMs = 30_000,
): Promise<EventMessage> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			off();
			reject(new Error(`ScriptedReasoner: timeout waiting for event/${eventType} (toolCallId=${toolCallId})`));
		}, timeoutMs);

		const off = bus.event.subscribe(eventType, (e: EventMessage) => {
			if (e.correlationId === correlationId && (e.payload as { toolCallId?: string }).toolCallId === toolCallId) {
				clearTimeout(timer);
				off();
				resolve(e);
			}
		});
	});
}
