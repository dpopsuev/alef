/**
 * Agent.validate() — seam cardinality enforcement.
 */

import type { Nerve, Organ } from "@dpopsuev/alef-spine";

import { describe, expect, it } from "vitest";
import { Agent } from "../src/index.js";

// ---------------------------------------------------------------------------
// Stub organs
// ---------------------------------------------------------------------------

/** Subscribes sense/dialog.message — satisfies primary_cognition seam. */
function makeReasoner(name = "llm"): Organ {
	return {
		name,
		tools: [],
		subscriptions: { motor: [] as const, sense: ["dialog.message"] as const },
		mount: (nerve: Nerve) => nerve.sense.subscribe("dialog.message", () => {}),
	};
}

/** Subscribes motor/fs.* — satisfies filesystem seam. */
function makeFsOrgan(): Organ {
	return {
		name: "fs",
		tools: [],
		subscriptions: { motor: ["fs.read", "fs.write"] as const, sense: [] as const },
		mount: (nerve: Nerve) => {
			const offs = [nerve.motor.subscribe("fs.read", () => {}), nerve.motor.subscribe("fs.write", () => {})];
			return () => {
				for (const o of offs) o();
			};
		},
	};
}

// ---------------------------------------------------------------------------

describe("Agent.validate()", () => {
	it("passes with a standard agent stack (LLM + FS)", () => {
		const agent = new Agent().load(makeReasoner()).load(makeFsOrgan());
		expect(() => agent.validate()).not.toThrow();
		agent.dispose();
	});

	it("passes with only Reasoner (fs is zero-or-one, not required)", () => {
		const agent = new Agent().load(makeReasoner());
		expect(() => agent.validate()).not.toThrow();
		agent.dispose();
	});

	it("does not throw when no reasoning organ is loaded — autonomous agents are valid", () => {
		// The 'reasoning' seam was removed from STANDARD_PORTS.
		// An agent with only corpus organs is valid — it waits for external trigger events.
		const agent = new Agent().load(makeFsOrgan());
		expect(() => agent.validate()).not.toThrow();
		agent.dispose();
	});

	it("does not throw when no organs are loaded — empty agent is valid at port level", () => {
		const agent = new Agent();
		expect(() => agent.validate()).not.toThrow();
		agent.dispose();
	});

	it("does not throw when two Reasoners are loaded — no exactly-one constraint on trigger", () => {
		// Without the 'reasoning' seam, there is no cardinality constraint on
		// how many organs handle sense/dialog.message. Agent author's responsibility.
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
