import type { Bus, BusMiddleware } from "./messages.js";
import { makeBus } from "./messages.js";

/** Resource limits for an adapter session: max tool calls and max elapsed time. */
export interface Budget {
	maxToolCalls?: number;
	maxElapsedMs?: number;
}

/** Merge two budgets, taking the stricter (lower) value for each field. */
export function intersectBudgets(limits: Budget, requests: Budget): Budget {
	const min = (a?: number, b?: number): number | undefined =>
		a === undefined ? b : b === undefined ? a : Math.min(a, b);
	return {
		maxToolCalls: min(limits.maxToolCalls, requests.maxToolCalls),
		maxElapsedMs: min(limits.maxElapsedMs, requests.maxElapsedMs),
	};
}

/** Bus middleware that rejects commands once the tool-call budget is exhausted. */
export function withLimits(limits: Budget): BusMiddleware {
	return (bus: Bus): Bus => {
		let toolCallCount = 0;
		return makeBus(
			{
				subscribe: bus.command.subscribe.bind(bus.command),
				publish: (event) => {
					if (limits.maxToolCalls !== undefined && toolCallCount >= limits.maxToolCalls) {
						bus.event.publish({
							type: event.type,
							correlationId: event.correlationId,
							payload: {},
							isError: true,
							errorMessage: `[budget] maxToolCalls (${limits.maxToolCalls}) exceeded`,
						});
						return;
					}
					toolCallCount++;
					bus.command.publish(event);
				},
			},
			bus.event,
			bus.notification,
			() => bus.pulse(),
		);
	};
}

/** Start a timer that publishes a budget.cancel event when maxElapsedMs is exceeded. */
export function startElapsedTimer(limits: Budget, bus: Bus): (() => void) | undefined {
	if (limits.maxElapsedMs === undefined) return undefined;
	const timer = setTimeout(() => {
		bus.event.publish({
			type: "budget.cancel",
			correlationId: "*",
			payload: { reason: "maxElapsedMs", limitMs: limits.maxElapsedMs },
			isError: false,
		});
	}, limits.maxElapsedMs);
	return () => clearTimeout(timer);
}
