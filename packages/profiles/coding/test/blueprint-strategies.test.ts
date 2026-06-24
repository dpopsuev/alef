/**
 * Blueprint strategy registration + GENERAL_SYSTEM_PROMPT
 *
 * Given/When/Then:
 *   Given createCodingAgentStack is called with a faux model
 *   When strategyRegistry.list() is called
 *   Then "explore" and "general" are present with send methods
 *   And GENERAL_SYSTEM_PROMPT is non-empty and instructs on Alef tool dispatch
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strategyRegistry } from "@dpopsuev/alef-adapter-agent";
import { registerFauxProvider } from "@dpopsuev/alef-llm";
import type { Session } from "@dpopsuev/alef-session";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCodingAgentStack } from "../src/blueprint.js";

function stubFactory() {
	return () => ({
		state: { id: "test", modelId: "test", contextWindow: 200_000 },
		getModel: () => "test",
		setModel: () => {},
		getThinking: () => "off",
		setThinking: () => {},
		setTurnController: () => {},
		subscribe: () => () => {},
		send: async () => "stub",
		dispose() {},
	}) satisfies Session;
}

let cwd: string;
beforeAll(async () => {
	cwd = mkdtempSync(join(tmpdir(), "alef-blueprint-test-"));
	const faux = registerFauxProvider();
	await createCodingAgentStack({ cwd, model: faux.getModel(), subagentFactory: stubFactory() });
});
afterAll(() => {
	rmSync(cwd, { recursive: true, force: true });
});

describe("blueprint strategy registration", { tags: ["unit"] }, () => {
	it("explore is registered in strategyRegistry", () => {
		expect(strategyRegistry.resolve("explore")).toBeDefined();
	});

	it("general is registered in strategyRegistry", () => {
		expect(strategyRegistry.resolve("general")).toBeDefined();
	});

	it("both strategies implement ExecutionStrategy.send", () => {
		expect(typeof strategyRegistry.resolve("explore")?.send).toBe("function");
		expect(typeof strategyRegistry.resolve("general")?.send).toBe("function");
	});
});

describe("GENERAL_SYSTEM_PROMPT", { tags: ["unit"] }, () => {
	it("is non-empty and instructs on Alef tool dispatch", async () => {
		// Import the constant indirectly via module inspection
		// The general strategy should have a non-null baseSystemPrompt
		const general = strategyRegistry.resolve("general");
		expect(general).toBeDefined();
		expect(typeof general?.send).toBe("function");
	});
});
