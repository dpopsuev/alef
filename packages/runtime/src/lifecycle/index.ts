import type { RuntimeComposition } from "../composer/index.js";

export type RuntimeLifecycleState = "bootstrapped" | "running" | "stopped";

export interface RuntimeLifecycle {
	composition: RuntimeComposition;
	state: RuntimeLifecycleState;
	startedAt?: number;
	stoppedAt?: number;
}

export function bootstrapLifecycle(composition: RuntimeComposition): RuntimeLifecycle {
	return {
		composition,
		state: "bootstrapped",
	};
}

export function startLifecycle(lifecycle: RuntimeLifecycle): RuntimeLifecycle {
	return {
		...lifecycle,
		state: "running",
		startedAt: lifecycle.startedAt ?? Date.now(),
	};
}

export function stopLifecycle(lifecycle: RuntimeLifecycle): RuntimeLifecycle {
	return {
		...lifecycle,
		state: "stopped",
		stoppedAt: Date.now(),
	};
}
