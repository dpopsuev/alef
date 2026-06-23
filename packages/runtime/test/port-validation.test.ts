/**
 * Agent.validate() — seam cardinality enforcement.
 */

import type { Adapter, Bus } from "@dpopsuev/alef-kernel";

import { describe, expect, it } from "vitest";
import { Agent } from "../src/index.js";

// ---------------------------------------------------------------------------
// Stub adapters
// ---------------------------------------------------------------------------

/** Subscribes event/llm.input — satisfies primary_cognition seam. */
function makeReasoner(name = "llm"): Adapter {
	return {
		name,
		tools: [],
		subscriptions: { command: [] as const, event: ["llm.input"] as const },
		sources: [],
		mount: (bus: Bus) => bus.event.subscribe("llm.input", () => {}),
	};
}

/** Subscribes command/fs.* — satisfies filesystem seam. */
function makeFsAdapter(): Adapter {
	return {
		name: "fs",
		tools: [],
		subscriptions: { command: ["fs.read", "fs.write"] as const, event: [] as const },
		sources: [],
		mount: (bus: Bus) => {
			const offs = [bus.command.subscribe("fs.read", () => {}), bus.command.subscribe("fs.write", () => {})];
			return () => {
				for (const o of offs) o();
			};
		},
	};
}

// ---------------------------------------------------------------------------

describe("Agent.validate()", { tags: ["unit"] }, () => {
	it("passes with a standard agent stack (LLM + FS)", () => {
		const agent = new Agent().load(makeReasoner()).load(makeFsAdapter());
		expect(() => agent.validate()).not.toThrow();
		agent.dispose();
	});

	it("passes with only Reasoner (fs is zero-or-one, not required)", () => {
		const agent = new Agent().load(makeReasoner());
		expect(() => agent.validate()).not.toThrow();
		agent.dispose();
	});

	it("does not throw when no reasoning adapter is loaded — autonomous agents are valid", () => {
		// The 'reasoning' seam was removed from STANDARD_PORTS.
		// An agent with only adapters is valid — it waits for external trigger events.
		const agent = new Agent().load(makeFsAdapter());
		expect(() => agent.validate()).not.toThrow();
		agent.dispose();
	});

	it("does not throw when no adapters are loaded — empty agent is valid at port level", () => {
		const agent = new Agent();
		expect(() => agent.validate()).not.toThrow();
		agent.dispose();
	});

	it("does not throw when two Reasoners are loaded — no exactly-one constraint on trigger", () => {
		// Without the 'reasoning' seam, there is no cardinality constraint on
		// how many adapters handle event/dialog.message. Agent author's responsibility.
		const agent = new Agent().load(makeReasoner("llm")).load(makeReasoner("mock-llm"));
		expect(() => agent.validate()).not.toThrow();
		agent.dispose();
	});

	it("returns this for chaining", () => {
		const agent = new Agent().load(makeReasoner());
		const result = agent.validate();
		expect(result).toBe(agent);
		agent.dispose();
	});
});
