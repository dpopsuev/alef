import type { ExecutionStrategy } from "@dpopsuev/alef-kernel";

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
