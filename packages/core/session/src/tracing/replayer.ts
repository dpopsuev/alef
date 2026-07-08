import { randomUUID } from "node:crypto";
import type { Adapter, ToolDefinition } from "@dpopsuev/alef-kernel/adapter";
import type { Bus } from "@dpopsuev/alef-kernel/bus";
import type { SessionTrace, TraceStep } from "./extractor.js";

/**
 *
 */
export class TraceReasonerAdapter implements Adapter {
	readonly name = "trace-reasoner";
	readonly tools: readonly ToolDefinition[] = [];
	readonly subscriptions = {
		command: [] as const,
		event: ["llm.input"] as readonly string[],
		notification: [] as const,
	};
	readonly sources = [] as const;

	private readonly steps: TraceStep[];
	private index = 0;

	constructor(trace: SessionTrace) {
		this.steps = [...trace];
	}

	mount(bus: Bus): () => void {
		return bus.event.subscribe("llm.input", (event) => {
			void (async () => {
				const step = this.steps[this.index++];
				if (!step) {
					bus.notification.publish({ type: "llm.chunk", payload: { text: "(trace exhausted)" }, correlationId: event.correlationId });
					bus.command.publish({ type: "llm.response", payload: { text: "(trace exhausted)" }, correlationId: event.correlationId });
					return;
				}

				for (const exec of step.toolExecutions) {
					const callId = exec.callId || randomUUID();
					bus.notification.publish({
						type: "llm.tool-start",
						payload: { callId, name: exec.toolName, args: exec.args },
						correlationId: event.correlationId,
					});

					const toolDone = new Promise<void>((resolve) => {
						const off = bus.event.subscribe(exec.toolName, (e) => {
							if ((e as { payload?: { toolCallId?: string } }).payload?.toolCallId === callId) {
								off();
								resolve();
							}
						});
					});

					bus.command.publish({
						type: exec.toolName,
						payload: { ...exec.args, toolCallId: callId },
						correlationId: event.correlationId,
					});

					await toolDone;

					bus.notification.publish({
						type: "llm.tool-end",
						payload: { callId, name: exec.toolName, ok: true, elapsedMs: exec.elapsed },
						correlationId: event.correlationId,
					});
				}

				if (step.finalReply) {
					bus.notification.publish({ type: "llm.chunk", payload: { text: step.finalReply }, correlationId: event.correlationId });
				}
				bus.notification.publish({
					type: "llm.token-usage",
					payload: { usage: { input: 0, output: 0, totalTokens: 0 } },
					correlationId: event.correlationId,
				});
				bus.command.publish({
					type: "llm.response",
					payload: { text: step.finalReply },
					correlationId: event.correlationId,
				});
			})();
		});
	}
}

/**
 *
 */
export class TraceToolAdapter implements Adapter {
	readonly name = "trace-tools";
	readonly tools: readonly ToolDefinition[] = [];
	readonly subscriptions: { command: readonly string[]; event: readonly string[]; notification: readonly string[] };
	readonly sources = [] as const;

	private readonly resultsByCallId = new Map<string, Record<string, unknown>>();
	private readonly resultsByType = new Map<string, Record<string, unknown>[]>();
	private readonly toolTypes: string[];

	constructor(trace: SessionTrace) {
		const types = new Set<string>();
		for (const step of trace) {
			for (const exec of step.toolExecutions) {
				types.add(exec.toolName);
				if (exec.callId) {
					this.resultsByCallId.set(exec.callId, exec.result);
				}
				const queue = this.resultsByType.get(exec.toolName) ?? [];
				queue.push(exec.result);
				this.resultsByType.set(exec.toolName, queue);
			}
		}
		this.toolTypes = [...types];
		this.subscriptions = { command: this.toolTypes, event: [], notification: [] };
	}

	mount(bus: Bus): () => void {
		const offs = this.toolTypes.map((toolType) =>
			bus.command.subscribe(toolType, (event) => {
				const toolCallId = (event as { payload?: { toolCallId?: string } }).payload?.toolCallId;
				if (!toolCallId) return;

				let result = this.resultsByCallId.get(toolCallId);
				if (!result) {
					const queue = this.resultsByType.get(event.type);
					result = queue?.shift();
				}

				const payload = result ? { ...result, toolCallId } : { content: [{ type: "text", text: "(replayed)" }], toolCallId };
				bus.event.publish({
					type: event.type,
					correlationId: event.correlationId,
					payload,
					isError: false,
				});
			}),
		);
		return () => { for (const off of offs) off(); };
	}
}

/**
 *
 */
export function createReplayAdapters(trace: SessionTrace): { reasoner: TraceReasonerAdapter; tools: TraceToolAdapter } {
	return {
		reasoner: new TraceReasonerAdapter(trace),
		tools: new TraceToolAdapter(trace),
	};
}
