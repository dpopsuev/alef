/**
 * Unit tests for runtime-handoff.ts — envelope creation, validation, and
 * lifecycle phase transitions.
 *
 * These are pure functions with no I/O. The supervisor-process-proof.test.ts
 * tests the full handoff flow end-to-end; these tests verify every individual
 * constraint, edge case, and phase transition in isolation.
 */

import { describe, expect, it } from "vitest";
import {
	createRuntimeHandoffEnvelope,
	markRuntimeHandoffAcked,
	markRuntimeHandoffFinalized,
	validateRuntimeHandoffEnvelope,
} from "../src/broker/runtime-handoff.js";

// ---------------------------------------------------------------------------
// createRuntimeHandoffEnvelope
// ---------------------------------------------------------------------------

describe("createRuntimeHandoffEnvelope", () => {
	it("creates a valid v1 envelope with required fields", () => {
		const env = createRuntimeHandoffEnvelope({
			updateId: "upd-123",
			sourceSlot: "green",
			targetSlot: "blue",
		});

		expect(env.schemaVersion).toBe("v1");
		expect(env.updateId).toBe("upd-123");
		expect(env.sourceSlot).toBe("green");
		expect(env.targetSlot).toBe("blue");
		expect(env.phase).toBe("prepared");
		expect(typeof env.preparedAt).toBe("number");
		expect(Number.isFinite(env.preparedAt)).toBe(true);
	});

	it("phase is always 'prepared' on creation", () => {
		const env = createRuntimeHandoffEnvelope({
			updateId: "upd-1",
			sourceSlot: "blue",
			targetSlot: "green",
		});
		expect(env.phase).toBe("prepared");
	});

	it("ackedAt and finalizedAt are absent initially", () => {
		const env = createRuntimeHandoffEnvelope({
			updateId: "upd-1",
			sourceSlot: "green",
			targetSlot: "blue",
		});
		expect(env.ackedAt).toBeUndefined();
		expect(env.finalizedAt).toBeUndefined();
	});

	it("includes optional sessionFile when provided", () => {
		const env = createRuntimeHandoffEnvelope({
			updateId: "upd-1",
			sourceSlot: "green",
			targetSlot: "blue",
			sessionFile: "/sessions/s.jsonl",
		});
		expect(env.sessionFile).toBe("/sessions/s.jsonl");
	});

	it("sessionFile is absent when not provided", () => {
		const env = createRuntimeHandoffEnvelope({
			updateId: "upd-1",
			sourceSlot: "green",
			targetSlot: "blue",
		});
		expect(env.sessionFile).toBeUndefined();
	});

	it("preparedAt is a recent timestamp", () => {
		const before = Date.now();
		const env = createRuntimeHandoffEnvelope({
			updateId: "x",
			sourceSlot: "green",
			targetSlot: "blue",
		});
		const after = Date.now();
		expect(env.preparedAt).toBeGreaterThanOrEqual(before);
		expect(env.preparedAt).toBeLessThanOrEqual(after);
	});
});

// ---------------------------------------------------------------------------
// markRuntimeHandoffAcked
// ---------------------------------------------------------------------------

describe("markRuntimeHandoffAcked", () => {
	const base = () => createRuntimeHandoffEnvelope({ updateId: "upd-1", sourceSlot: "green", targetSlot: "blue" });

	it("sets phase to 'acked'", () => {
		const acked = markRuntimeHandoffAcked(base());
		expect(acked.phase).toBe("acked");
	});

	it("sets ackedAt to a finite timestamp", () => {
		const before = Date.now();
		const acked = markRuntimeHandoffAcked(base());
		const after = Date.now();
		expect(typeof acked.ackedAt).toBe("number");
		expect(acked.ackedAt).toBeGreaterThanOrEqual(before);
		expect(acked.ackedAt).toBeLessThanOrEqual(after);
	});

	it("preserves all other fields", () => {
		const original = base();
		const acked = markRuntimeHandoffAcked(original);
		expect(acked.updateId).toBe(original.updateId);
		expect(acked.sourceSlot).toBe(original.sourceSlot);
		expect(acked.targetSlot).toBe(original.targetSlot);
		expect(acked.preparedAt).toBe(original.preparedAt);
		expect(acked.schemaVersion).toBe("v1");
	});

	it("does not mutate the original envelope", () => {
		const original = base();
		const originalPhase = original.phase;
		markRuntimeHandoffAcked(original);
		expect(original.phase).toBe(originalPhase);
	});
});

// ---------------------------------------------------------------------------
// markRuntimeHandoffFinalized
// ---------------------------------------------------------------------------

describe("markRuntimeHandoffFinalized", () => {
	const base = () => {
		const prepared = createRuntimeHandoffEnvelope({
			updateId: "upd-1",
			sourceSlot: "green",
			targetSlot: "blue",
		});
		return markRuntimeHandoffAcked(prepared);
	};

	it("sets phase to 'finalized'", () => {
		const finalized = markRuntimeHandoffFinalized(base());
		expect(finalized.phase).toBe("finalized");
	});

	it("sets finalizedAt to a finite timestamp", () => {
		const before = Date.now();
		const finalized = markRuntimeHandoffFinalized(base());
		const after = Date.now();
		expect(typeof finalized.finalizedAt).toBe("number");
		expect(finalized.finalizedAt).toBeGreaterThanOrEqual(before);
		expect(finalized.finalizedAt).toBeLessThanOrEqual(after);
	});

	it("preserves ackedAt from the acked envelope", () => {
		const acked = base();
		const finalized = markRuntimeHandoffFinalized(acked);
		expect(finalized.ackedAt).toBe(acked.ackedAt);
	});

	it("does not mutate the input envelope", () => {
		const acked = base();
		const originalPhase = acked.phase;
		markRuntimeHandoffFinalized(acked);
		expect(acked.phase).toBe(originalPhase);
	});
});

// ---------------------------------------------------------------------------
// validateRuntimeHandoffEnvelope
// ---------------------------------------------------------------------------

describe("validateRuntimeHandoffEnvelope", () => {
	const valid = () => createRuntimeHandoffEnvelope({ updateId: "upd-1", sourceSlot: "green", targetSlot: "blue" });

	it("returns empty diagnostics for a valid prepared envelope", () => {
		expect(validateRuntimeHandoffEnvelope(valid())).toEqual([]);
	});

	it("returns empty diagnostics for a valid acked envelope", () => {
		expect(validateRuntimeHandoffEnvelope(markRuntimeHandoffAcked(valid()))).toEqual([]);
	});

	it("returns empty diagnostics for a valid finalized envelope", () => {
		expect(validateRuntimeHandoffEnvelope(markRuntimeHandoffFinalized(markRuntimeHandoffAcked(valid())))).toEqual([]);
	});

	it("rejects null with a top-level diagnostic", () => {
		const diags = validateRuntimeHandoffEnvelope(null);
		expect(diags.length).toBeGreaterThan(0);
		expect(diags[0]?.path).toBe("envelope");
	});

	it("rejects non-object with a top-level diagnostic", () => {
		expect(validateRuntimeHandoffEnvelope("string")).not.toEqual([]);
		expect(validateRuntimeHandoffEnvelope(42)).not.toEqual([]);
	});

	it("rejects wrong schemaVersion", () => {
		const env = { ...valid(), schemaVersion: "v2" };
		const diags = validateRuntimeHandoffEnvelope(env);
		expect(diags.some((d) => d.path === "envelope.schemaVersion")).toBe(true);
	});

	it("rejects empty updateId", () => {
		const env = { ...valid(), updateId: "" };
		const diags = validateRuntimeHandoffEnvelope(env);
		expect(diags.some((d) => d.path === "envelope.updateId")).toBe(true);
	});

	it("rejects invalid sourceSlot", () => {
		const env = { ...valid(), sourceSlot: "purple" };
		const diags = validateRuntimeHandoffEnvelope(env);
		expect(diags.some((d) => d.path === "envelope.sourceSlot")).toBe(true);
	});

	it("rejects invalid targetSlot", () => {
		const env = { ...valid(), targetSlot: "red" };
		const diags = validateRuntimeHandoffEnvelope(env);
		expect(diags.some((d) => d.path === "envelope.targetSlot")).toBe(true);
	});

	it("rejects invalid phase", () => {
		const env = { ...valid(), phase: "unknown" };
		const diags = validateRuntimeHandoffEnvelope(env);
		expect(diags.some((d) => d.path === "envelope.phase")).toBe(true);
	});

	it("rejects non-finite preparedAt", () => {
		const env = { ...valid(), preparedAt: NaN };
		const diags = validateRuntimeHandoffEnvelope(env);
		expect(diags.some((d) => d.path === "envelope.preparedAt")).toBe(true);
	});

	it("rejects non-finite ackedAt when provided", () => {
		const env = { ...valid(), ackedAt: Infinity };
		const diags = validateRuntimeHandoffEnvelope(env);
		expect(diags.some((d) => d.path === "envelope.ackedAt")).toBe(true);
	});

	it("accepts missing ackedAt (it's optional)", () => {
		const env = { ...valid() };
		const diags = validateRuntimeHandoffEnvelope(env);
		expect(diags.some((d) => d.path === "envelope.ackedAt")).toBe(false);
	});

	it("rejects empty sessionFile when provided", () => {
		const env = { ...valid(), sessionFile: "" };
		const diags = validateRuntimeHandoffEnvelope(env);
		expect(diags.some((d) => d.path === "envelope.sessionFile")).toBe(true);
	});

	it("accepts missing sessionFile (it's optional)", () => {
		const diags = validateRuntimeHandoffEnvelope(valid());
		expect(diags.some((d) => d.path === "envelope.sessionFile")).toBe(false);
	});

	it("collects all errors in one pass — not short-circuit", () => {
		const env = {
			schemaVersion: "v99",
			updateId: "",
			sourceSlot: "bad",
			targetSlot: "bad",
			phase: "nope",
			preparedAt: NaN,
		};
		const diags = validateRuntimeHandoffEnvelope(env);
		expect(diags.length).toBeGreaterThanOrEqual(5);
	});
});

// ---------------------------------------------------------------------------
// Phase progression invariants
// ---------------------------------------------------------------------------

describe("handoff phase progression", () => {
	it("prepared -> acked -> finalized is the canonical lifecycle", () => {
		const prepared = createRuntimeHandoffEnvelope({
			updateId: "upd-lifecycle",
			sourceSlot: "green",
			targetSlot: "blue",
		});
		expect(prepared.phase).toBe("prepared");

		const acked = markRuntimeHandoffAcked(prepared);
		expect(acked.phase).toBe("acked");
		expect(acked.ackedAt).toBeDefined();

		const finalized = markRuntimeHandoffFinalized(acked);
		expect(finalized.phase).toBe("finalized");
		expect(finalized.finalizedAt).toBeDefined();

		// Timestamps are ordered
		expect(finalized.preparedAt).toBeLessThanOrEqual(finalized.ackedAt!);
		expect(finalized.ackedAt!).toBeLessThanOrEqual(finalized.finalizedAt!);
	});

	it("validate passes at every phase", () => {
		const prepared = createRuntimeHandoffEnvelope({
			updateId: "upd-validate",
			sourceSlot: "blue",
			targetSlot: "green",
		});
		expect(validateRuntimeHandoffEnvelope(prepared)).toEqual([]);

		const acked = markRuntimeHandoffAcked(prepared);
		expect(validateRuntimeHandoffEnvelope(acked)).toEqual([]);

		const finalized = markRuntimeHandoffFinalized(acked);
		expect(validateRuntimeHandoffEnvelope(finalized)).toEqual([]);
	});
});
