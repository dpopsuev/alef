import type { Nerve, NerveMiddleware } from "./buses.js";

export interface Budget {
	maxTokens?: number;
	maxTurns?: number;
	maxToolCalls?: number;
	maxElapsedMs?: number;
	maxConcurrency?: number;
}

export function intersectBudgets(limits: Budget, requests: Budget): Budget {
	const min = (a?: number, b?: number): number | undefined =>
		a === undefined ? b : b === undefined ? a : Math.min(a, b);
	return {
		maxTokens: min(limits.maxTokens, requests.maxTokens),
		maxTurns: min(limits.maxTurns, requests.maxTurns),
		maxToolCalls: min(limits.maxToolCalls, requests.maxToolCalls),
		maxElapsedMs: min(limits.maxElapsedMs, requests.maxElapsedMs),
		maxConcurrency: min(limits.maxConcurrency, requests.maxConcurrency),
	};
}

export function withLimits(limits: Budget): NerveMiddleware {
	return (nerve: Nerve): Nerve => {
		let toolCallCount = 0;
		let elapsedTimer: ReturnType<typeof setTimeout> | undefined;
		let abortController: AbortController | undefined;

		if (limits.maxElapsedMs !== undefined) {
			abortController = new AbortController();
			elapsedTimer = setTimeout(() => {
				abortController?.abort(new Error(`[budget] maxElapsedMs (${limits.maxElapsedMs}ms) exceeded`));
			}, limits.maxElapsedMs);
		}

		const cleanup = () => {
			if (elapsedTimer !== undefined) clearTimeout(elapsedTimer);
		};

		return {
			motor: {
				subscribe: nerve.motor.subscribe.bind(nerve.motor),
				publish: (event) => {
					if (limits.maxToolCalls !== undefined && toolCallCount >= limits.maxToolCalls) {
						nerve.sense.publish({
							type: event.type,
							correlationId: event.correlationId,
							payload: {},
							isError: true,
							errorMessage: `[budget] maxToolCalls (${limits.maxToolCalls}) exceeded`,
						});
						cleanup();
						return;
					}
					toolCallCount++;
					nerve.motor.publish(event);
				},
			},
			sense: nerve.sense,
		};
	};
}
