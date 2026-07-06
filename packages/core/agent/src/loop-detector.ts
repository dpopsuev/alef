/**
 * LoopGuard — production loop guard.
 *
 * Detects two distinct loop patterns:
 *
 *   1. Full interaction repetition (definite loop): the same tool is called
 *      with identical arguments AND produces the same result N times in one
 *      turn. Full interaction hash — hashing
 *      (type + args + result) together. A tool returning different content
 *      each call is not a loop; identical (call, result) pairs N times is.
 *      Default threshold: 3.
 *
 *   2. Total call safety net: a single tool is called an extreme number of
 *      times regardless of argument or result variation. Default threshold: 40.
 *
 * Implementation:
 *   - Command subscriber buffers pending calls by toolCallId.
 *   - Event subscriber picks up the result, computes the full hash, checks.
 *   - Reset all counters on new correlationId (new user turn).
 *
 * When a loop is detected, onLoop() is called. The caller is responsible for
 * termination — typically by aborting the current turn's AbortController.
 */

import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import type { Bus, EventMessage } from "@dpopsuev/alef-kernel/bus";
import { extractToolCallId } from "@dpopsuev/alef-kernel/bus";

const DEFAULT_REPEATED_INTERACTION_THRESHOLD = 3;
const DEFAULT_TOTAL_CALL_THRESHOLD = 40;
const RESULT_HASH_MAX_CHARS = 512;

/**
 *
 */
export interface LoopGuardOptions {
	/**
	 * How many times the same (tool, args, result) triple may appear
	 * before it is considered a loop. Default: 3.
	 */
	repeatedInteractionThreshold?: number;
	/**
	 * Absolute cap on how many times any single tool may be called per turn,
	 * regardless of variation. Default: 40.
	 */
	totalCallThreshold?: number;
	/** Called when a loop is detected. Abort the turn here. */
	onLoop?: (eventType: string, reason: string) => void;
}

interface PendingCall {
	type: string;
	argsHash: string;
	correlationId: string;
}

/** Stable JSON hash of tool arguments, stripping internal bookkeeping fields. */
function hashArgs(payload: Record<string, unknown>): string {
	const { toolCallId: _tc, isFinal: _if, _display: _d, ...args } = payload;
	const keys = Object.keys(args).sort();
	return JSON.stringify(Object.fromEntries(keys.map((k) => [k, args[k]])));
}

/** Extract a stable text representation of a event result for hashing. */
function hashResult(payload: Record<string, unknown>): string {
	const { toolCallId: _tc, isFinal: _if, _display: _d, ...rest } = payload;
	// For streaming adapters: intermediate chunks have isFinal:false — skip them.
	// Only hash the final payload.
	if (payload.isFinal === false) return "";
	if (typeof rest.content === "string") return rest.content.slice(0, RESULT_HASH_MAX_CHARS);
	// Anthropic-format content array: [{ type: "text", text: "..." }]
	// typeof check above misses this case, causing false-negative loop detection.
	if (Array.isArray(rest.content)) {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- rest.content is unknown; array shape validated by Array.isArray guard above
		const block = (rest.content as { type?: string; text?: unknown }[]).find((b) => b.type === "text");
		if (typeof block?.text === "string") return block.text.slice(0, RESULT_HASH_MAX_CHARS);
	}
	if (typeof rest.text === "string") return rest.text.slice(0, RESULT_HASH_MAX_CHARS);
	if (typeof rest.output === "string") return rest.output.slice(0, RESULT_HASH_MAX_CHARS);
	return JSON.stringify(rest).slice(0, RESULT_HASH_MAX_CHARS);
}

/**
 *
 */
export class LoopGuard implements Adapter {
	readonly name = "loop-detector";
	readonly tools = [];
	readonly subscriptions = { command: ["*" as const], event: [] as const, notification: [] as const };
	readonly sources = [] as const;

	private readonly repeatedInteractionThreshold: number;
	private readonly totalCallThreshold: number;
	private readonly onLoop: (eventType: string, reason: string) => void;

	constructor(opts: LoopGuardOptions = {}) {
		this.repeatedInteractionThreshold = opts.repeatedInteractionThreshold ?? DEFAULT_REPEATED_INTERACTION_THRESHOLD;
		this.totalCallThreshold = opts.totalCallThreshold ?? DEFAULT_TOTAL_CALL_THRESHOLD;
		this.onLoop =
			opts.onLoop ??
			// Default writes to stderr — safe only before TUI starts.
			// TUI callers must pass onLoop that routes through trace() instead.
			((_, reason) => {
				process.stderr.write(`\n[loop-detector] ${reason}\n`);
			});
	}

	mount(bus: Bus): () => void {
		// pending: toolCallId → PendingCall (buffered until event result arrives)
		// interactionCounts: Map<type, Map<interactionHash, count>>
		// totalCounts: Map<type, totalCallCount>
		const pending = new Map<string, PendingCall>();
		const interactionCounts = new Map<string, Map<string, number>>();
		const totalCounts = new Map<string, number>();
		let lastCorrelationId: string | undefined;

		const resetIfNewTurn = (corr: string) => {
			if (corr !== lastCorrelationId) {
				pending.clear();
				interactionCounts.clear();
				totalCounts.clear();
				lastCorrelationId = corr;
			}
		};

		// Command subscriber: buffer call metadata, apply total-count safety net.
		// Only count events that carry a toolCallId — those are real tool dispatches.
		// Infrastructure command events (llm.response, context.assemble) are skipped.
		const offMotor = bus.command.subscribe("*", (event) => {
			const corr = event.correlationId;
			resetIfNewTurn(corr);

			const type = event.type;
			const toolCallId = extractToolCallId(event.payload);
			if (!toolCallId) return;

			// Safety net: total calls per tool regardless of interaction.
			const prevTotal = totalCounts.get(type) ?? 0;
			const nextTotal = prevTotal + 1;
			totalCounts.set(type, nextTotal);

			if (nextTotal > this.totalCallThreshold) {
				this.onLoop(
					type,
					`Tool '${type}' called ${nextTotal} times in one turn (limit: ${this.totalCallThreshold}).`,
				);
				return;
			}

			// Buffer this call so the event subscriber can complete the hash.
			pending.set(toolCallId, {
				type,
				argsHash: hashArgs(event.payload),
				correlationId: corr,
			});
		});

		// Event subscriber: complete the interaction hash with the result.
		const offSense = bus.event.subscribe("*" as const, (event: EventMessage) => {
			const toolCallId = extractToolCallId(event.payload);
			if (!toolCallId) return;

			const call = pending.get(toolCallId);
			if (!call) return;

			const resultHash = hashResult(event.payload);
			// Intermediate streaming chunks: skip (hashResult returns "").
			if (resultHash === "") return;

			pending.delete(toolCallId);

			const interactionHash = `${call.argsHash}\x00${resultHash}`;
			const type = call.type;

			let perType = interactionCounts.get(type);
			if (!perType) {
				perType = new Map();
				interactionCounts.set(type, perType);
			}
			const prev = perType.get(interactionHash) ?? 0;
			const next = prev + 1;
			perType.set(interactionHash, next);

			if (next > this.repeatedInteractionThreshold) {
				this.onLoop(
					type,
					`Tool '${type}' produced identical output ${next} times with the same arguments ` +
						`(limit: ${this.repeatedInteractionThreshold}). Stuck in a loop.`,
				);
			}
		});

		return () => {
			offMotor();
			offSense();
			pending.clear();
			interactionCounts.clear();
			totalCounts.clear();
		};
	}
}
