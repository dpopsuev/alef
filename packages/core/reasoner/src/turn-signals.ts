import type { Bus } from "@dpopsuev/alef-kernel/bus";

/** Abort-signal management for a single turn — budget cancellation, per-call abort, and cleanup. */
export interface TurnSignals {
	readonly effectiveSignal: AbortSignal;
	readonly callAbortControllers: Map<string, AbortController>;
	dispose(): void;
}

/** Wire budget-cancel and per-tool-call abort controllers into a composite AbortSignal for the turn. */
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
