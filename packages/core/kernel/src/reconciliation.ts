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

export interface DomainCondition {
	readonly domain: string;
	readonly key: string;
	readonly value: unknown;
	readonly confidence: number;
	readonly observedAt: number;
}

export interface ActualConditions {
	readonly adapterId: string;
	readonly conditions: readonly DomainCondition[];
	readonly healthy: boolean;
	readonly observedAt: number;
}

export interface DesiredStateSpec {
	readonly intent: string;
	readonly dimensions: readonly {
		readonly domain: string;
		readonly key: string;
		readonly target: unknown;
		readonly priority: number;
	}[];
}

export interface ErrorDimension {
	readonly domain: string;
	readonly key: string;
	readonly target: unknown;
	readonly actual: unknown;
	readonly magnitude: number;
}

export interface ErrorTensor {
	readonly dimensions: readonly ErrorDimension[];
	readonly totalMagnitude: number;
	readonly converged: boolean;
	readonly computedAt: number;
}

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

export function detectDrift(previous: ErrorTensor, current: ErrorTensor): readonly ErrorDimension[] {
	const prevMap = new Map(previous.dimensions.map((d) => [`${d.domain}:${d.key}`, d]));
	return current.dimensions.filter((d) => {
		const prev = prevMap.get(`${d.domain}:${d.key}`);
		return prev !== undefined && prev.magnitude === 0 && d.magnitude > 0;
	});
}
