import type { Bus } from "@dpopsuev/alef-kernel";

export interface TurnSignals {
	readonly effectiveSignal: AbortSignal;
	readonly callAbortControllers: Map<string, AbortController>;
	dispose(): void;
}

export function createTurnSignals(
	sense: Bus["event"],
	signal: Bus["notification"],
	userSignal?: AbortSignal,
): TurnSignals {
	const budgetController = new AbortController();
	const callAbortControllers = new Map<string, AbortController>();

	const offBudget = sense.subscribe("budget.cancel", () => {
		budgetController.abort(new Error("[budget] maxElapsedMs exceeded"));
	});
	const offCancel = signal.subscribe("tools.cancel-request", (event) => {
		const callId = (event as { payload?: { callId?: string } }).payload?.callId;
		if (callId) callAbortControllers.get(callId)?.abort(new Error(`Cancelled by tools.cancel: ${callId}`));
	});

	const effectiveSignal = userSignal
		? AbortSignal.any([budgetController.signal, userSignal])
		: budgetController.signal;

	return {
		effectiveSignal,
		callAbortControllers,
		dispose() {
			offBudget();
			offCancel();
		},
	};
}
