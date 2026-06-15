import type { Nerve, NerveMiddleware } from "./buses.js";

export interface Budget {
	maxToolCalls?: number;
	maxElapsedMs?: number;
}

export function intersectBudgets(limits: Budget, requests: Budget): Budget {
	const min = (a?: number, b?: number): number | undefined =>
		a === undefined ? b : b === undefined ? a : Math.min(a, b);
	return {
		maxToolCalls: min(limits.maxToolCalls, requests.maxToolCalls),
		maxElapsedMs: min(limits.maxElapsedMs, requests.maxElapsedMs),
	};
}

export function withLimits(limits: Budget): NerveMiddleware {
	return (nerve: Nerve): Nerve => {
		let toolCallCount = 0;
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
						return;
					}
					toolCallCount++;
					nerve.motor.publish(event);
				},
			},
			sense: nerve.sense,
			signal: nerve.signal,
			pulse: () => nerve.pulse(),
		};
	};
}

export function startElapsedTimer(limits: Budget, nerve: Nerve): (() => void) | undefined {
	if (limits.maxElapsedMs === undefined) return undefined;
	const timer = setTimeout(() => {
		nerve.sense.publish({
			type: "budget.cancel",
			correlationId: "*",
			payload: { reason: "maxElapsedMs", limitMs: limits.maxElapsedMs },
			isError: false,
		});
	}, limits.maxElapsedMs);
	return () => clearTimeout(timer);
}
