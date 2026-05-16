/**
 * Agent.validate() — seam cardinality enforcement.
 */

import type { Nerve, Organ } from "@dpopsuev/alef-spine";
import { SeamValidationError } from "@dpopsuev/alef-spine";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/index.js";

// ---------------------------------------------------------------------------
// Stub organs
// ---------------------------------------------------------------------------

/** Subscribes sense/dialog.message — satisfies primary_cognition seam. */
function makeLLMOrgan(name = "llm"): Organ {
	return {
		name,
		tools: [],
		mount: (nerve: Nerve) => nerve.sense.subscribe("dialog.message", () => {}),
	};
}

/** Subscribes motor/fs.* — satisfies filesystem seam. */
function makeFsOrgan(): Organ {
	return {
		name: "fs",
		tools: [],
		mount: (nerve: Nerve) => {
			const offs = [nerve.motor.subscribe("fs.read", () => {}), nerve.motor.subscribe("fs.write", () => {})];
			return () => {
				for (const o of offs) o();
			};
		},
	};
}

/** Does not subscribe to any relevant seam. */
function makeInertOrgan(): Organ {
	return {
		name: "inert",
		tools: [],
		mount: () => () => {},
	};
}

// ---------------------------------------------------------------------------

describe("Agent.validate()", () => {
	it("passes with a standard agent stack (LLM + FS)", () => {
		const agent = new Agent().load(makeLLMOrgan()).load(makeFsOrgan());
		expect(() => agent.validate()).not.toThrow();
		agent.dispose();
	});

	it("passes with only LLMOrgan (fs is zero-or-one, not required)", () => {
		const agent = new Agent().load(makeLLMOrgan());
		expect(() => agent.validate()).not.toThrow();
		agent.dispose();
	});

	it("throws SeamValidationError when no reasoning organ is loaded", () => {
		const agent = new Agent().load(makeFsOrgan());
		expect(() => agent.validate()).toThrow(SeamValidationError);
		agent.dispose();
	});

	it("throws when no organs are loaded at all", () => {
		const agent = new Agent();
		expect(() => agent.validate()).toThrow(SeamValidationError);
		agent.dispose();
	});

	it("throws when two LLMOrgans are loaded", () => {
		const agent = new Agent().load(makeLLMOrgan("llm")).load(makeLLMOrgan("mock-llm"));
		expect(() => agent.validate()).toThrow(SeamValidationError);
		agent.dispose();
	});

	it("error message names the missing seam", () => {
		const agent = new Agent().load(makeInertOrgan());
		try {
			agent.validate();
			expect.fail("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(SeamValidationError);
			expect((e as SeamValidationError).message).toMatch(/primary_cognition/);
		}
		agent.dispose();
	});

	it("returns this for chaining", () => {
		const agent = new Agent().load(makeLLMOrgan());
		const result = agent.validate();
		expect(result).toBe(agent);
		agent.dispose();
	});
});
