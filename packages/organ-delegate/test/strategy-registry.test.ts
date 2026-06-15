/**
 * StrategyRegistry — module-level catalog of named execution strategies.
 *
 * Given/When/Then:
 *   Given a strategy is registered by name
 *   When DelegateOrgan resolves a profile
 *   Then it finds the registered strategy and not an error
 */

import type { ExecutionStrategy } from "@dpopsuev/alef-kernel";
import { describe, expect, it } from "vitest";
import { strategyRegistry } from "../src/index.js";

function makeStubStrategy(name: string): ExecutionStrategy {
	return {
		async send() {
			return `reply from ${name}`;
		},
	};
}

describe("StrategyRegistry", { tags: ["unit"] }, () => {
	it("register and resolve a named strategy", () => {
		const strategy = makeStubStrategy("test-research");
		strategyRegistry.register("test-research", strategy);
		expect(strategyRegistry.resolve("test-research")).toBe(strategy);
	});

	it("resolve returns undefined for unknown name", () => {
		expect(strategyRegistry.resolve("__no_such_strategy__")).toBeUndefined();
	});

	it("list includes registered names", () => {
		strategyRegistry.register("test-list-a", makeStubStrategy("list-a"));
		strategyRegistry.register("test-list-b", makeStubStrategy("list-b"));
		expect(strategyRegistry.list()).toContain("test-list-a");
		expect(strategyRegistry.list()).toContain("test-list-b");
	});

	it("second register overwrites first for same name", () => {
		const first = makeStubStrategy("first");
		const second = makeStubStrategy("second");
		strategyRegistry.register("test-overwrite", first);
		strategyRegistry.register("test-overwrite", second);
		expect(strategyRegistry.resolve("test-overwrite")).toBe(second);
	});
});
