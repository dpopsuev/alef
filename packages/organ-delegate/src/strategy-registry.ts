import type { ExecutionStrategy } from "@dpopsuev/alef-kernel";

/**
 * Module-level catalog of named execution strategies.
 *
 * DelegateOrgan first checks its instance-level strategies map (for
 * orchestration-spawned children), then falls back to this registry
 * (for built-in and externally registered profiles like explore/general).
 *
 * Registration is a side effect: importing the module that calls
 * strategyRegistry.register() (e.g. alef-coding-agent/src/blueprint.ts)
 * populates the registry at process startup.
 */
class StrategyRegistry {
	private readonly _registry = new Map<string, ExecutionStrategy>();

	register(name: string, strategy: ExecutionStrategy): void {
		this._registry.set(name, strategy);
	}

	resolve(name: string): ExecutionStrategy | undefined {
		return this._registry.get(name);
	}

	list(): string[] {
		return [...this._registry.keys()];
	}
}

export const strategyRegistry = new StrategyRegistry();
