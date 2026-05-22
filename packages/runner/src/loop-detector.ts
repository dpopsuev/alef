/**
 * LoopDetectorOrgan — production loop guard.
 *
 * Detects two distinct loop patterns:
 *
 *   1. Argument repetition (definite loop): the same tool is called with
 *      identical arguments N times in one turn. Default threshold: 3.
 *      Reading 18 different files is NOT a loop.
 *      Reading the same file 3 times IS a loop.
 *
 *   2. Total call safety net: a single tool is called an extreme number of
 *      times regardless of argument variation. Default threshold: 40.
 *
 * When a loop is detected, onLoop() is called. The caller is responsible for
 * termination — typically by aborting the current turn's AbortController.
 * No sense events are injected; termination is handled out-of-band.
 */

import type { Nerve, Organ } from "@dpopsuev/alef-spine";

export interface LoopDetectorOptions {
	/**
	 * How many times the same tool may be called with identical arguments
	 * before it is considered a loop. Default: 3.
	 */
	repeatedArgThreshold?: number;
	/**
	 * Absolute cap on how many times any single tool may be called per turn,
	 * regardless of argument variation. Default: 40.
	 */
	totalCallThreshold?: number;
	/** Called when a loop is detected. Abort the turn here. */
	onLoop?: (eventType: string, reason: string) => void;
}

/** Stable JSON hash of tool arguments, stripping internal bookkeeping fields. */
function hashArgs(payload: Record<string, unknown>): string {
	const { toolCallId: _tc, isFinal: _if, _display: _d, ...args } = payload;
	const keys = Object.keys(args).sort();
	return JSON.stringify(Object.fromEntries(keys.map((k) => [k, args[k]])));
}

export class LoopDetectorOrgan implements Organ {
	readonly name = "loop-detector";
	readonly tools = [];
	readonly subscriptions = { motor: ["*" as const], sense: [] as const };

	private readonly repeatedArgThreshold: number;
	private readonly totalCallThreshold: number;
	private readonly onLoop: (eventType: string, reason: string) => void;

	constructor(opts: LoopDetectorOptions = {}) {
		this.repeatedArgThreshold = opts.repeatedArgThreshold ?? 3;
		this.totalCallThreshold = opts.totalCallThreshold ?? 40;
		this.onLoop =
			opts.onLoop ??
			((_, reason) => {
				process.stderr.write(`\n[loop-detector] ${reason}\n`);
			});
	}

	mount(nerve: Nerve): () => void {
		// argCounts: Map<type, Map<argsHash, count>>
		// totalCounts: Map<type, count>
		// Both are reset on each new turn (correlationId change).
		const argCounts = new Map<string, Map<string, number>>();
		const totalCounts = new Map<string, number>();
		let lastCorrelationId: string | undefined;

		const off = nerve.motor.subscribe("*", (event) => {
			const corr = event.correlationId ?? "none";

			if (corr !== lastCorrelationId) {
				argCounts.clear();
				totalCounts.clear();
				lastCorrelationId = corr;
			}

			const type = event.type;

			// Safety net: total calls per tool regardless of args.
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

			// Argument repetition: same tool + same args.
			const argsHash = hashArgs(event.payload);
			let perType = argCounts.get(type);
			if (!perType) {
				perType = new Map();
				argCounts.set(type, perType);
			}
			const prevArg = perType.get(argsHash) ?? 0;
			const nextArg = prevArg + 1;
			perType.set(argsHash, nextArg);

			if (nextArg > this.repeatedArgThreshold) {
				this.onLoop(
					type,
					`Tool '${type}' called ${nextArg} times with identical arguments (limit: ${this.repeatedArgThreshold}).`,
				);
			}
		});

		return () => {
			off();
			argCounts.clear();
			totalCounts.clear();
		};
	}
}
