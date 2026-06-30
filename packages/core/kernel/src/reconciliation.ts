/**
 * Control Theory types for agent reconciliation.
 *
 * The agent is a reconciliation controller: it observes actual conditions (AC),
 * compares against a desired state specification (DSS), computes an error tensor
 * (the gap), and executes actions to drive AC toward DSS.
 *
 * Terminology from control theory + K8s controller model:
 *   DSS  = Desired State Specification (the user's intent, parsed)
 *   AC   = Actual Conditions (per-adapter domain state)
 *   Error = DSS - AC (what's missing or wrong)
 *   Plan = sequence of actions to reduce error
 */

/** Single observed fact from an adapter's domain with a confidence score. */
export interface DomainCondition {
	readonly domain: string;
	readonly key: string;
	readonly value: unknown;
	readonly confidence: number;
	readonly observedAt: number;
}

/** Snapshot of all observed domain conditions from a single adapter. */
export interface ActualConditions {
	readonly adapterId: string;
	readonly conditions: readonly DomainCondition[];
	readonly healthy: boolean;
	readonly observedAt: number;
}

/** User intent parsed into prioritised target dimensions the agent must satisfy. */
export interface DesiredStateSpec {
	readonly intent: string;
	readonly dimensions: readonly {
		readonly domain: string;
		readonly key: string;
		readonly target: unknown;
		readonly priority: number;
	}[];
}

/** Single axis of the gap between desired and actual state. */
export interface ErrorDimension {
	readonly domain: string;
	readonly key: string;
	readonly target: unknown;
	readonly actual: unknown;
	readonly magnitude: number;
}

/** Aggregated error across all dimensions, indicating whether convergence has been reached. */
export interface ErrorTensor {
	readonly dimensions: readonly ErrorDimension[];
	readonly totalMagnitude: number;
	readonly converged: boolean;
	readonly computedAt: number;
}

/** Compute the error tensor by comparing desired state against observed actual conditions. */
export function computeError(dss: DesiredStateSpec, conditions: readonly ActualConditions[]): ErrorTensor {
	const allConditions = new Map<string, DomainCondition>();
	for (const ac of conditions) {
		for (const c of ac.conditions) {
			allConditions.set(`${c.domain}:${c.key}`, c);
		}
	}

	const dimensions: ErrorDimension[] = [];
	for (const dim of dss.dimensions) {
		const key = `${dim.domain}:${dim.key}`;
		const actual = allConditions.get(key);
		const magnitude = actual === undefined ? 1.0 : actual.value === dim.target ? 0.0 : dim.priority;
		dimensions.push({
			domain: dim.domain,
			key: dim.key,
			target: dim.target,
			actual: actual?.value,
			magnitude,
		});
	}

	const totalMagnitude = dimensions.reduce((sum, d) => sum + d.magnitude, 0);
	return {
		dimensions,
		totalMagnitude,
		converged: totalMagnitude === 0,
		computedAt: Date.now(),
	};
}

/** Return dimensions that regressed from converged (magnitude 0) to diverged between two snapshots. */
export function detectDrift(previous: ErrorTensor, current: ErrorTensor): readonly ErrorDimension[] {
	const prevMap = new Map(previous.dimensions.map((d) => [`${d.domain}:${d.key}`, d]));
	return current.dimensions.filter((d) => {
		const prev = prevMap.get(`${d.domain}:${d.key}`);
		return prev !== undefined && prev.magnitude === 0 && d.magnitude > 0;
	});
}
