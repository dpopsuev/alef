/**
 * Binding chain test: ordered mechanical → LLM → human evaluators.
 *
 * Verifies:
 *   - three-stage ordered chain fires in sequence
 *   - each stage self-selects via targetOrgan
 *   - short-circuit: mechanical rejection skips stages 2 and 3
 *   - parallel-all mode: both must approve
 */

import type { Binding } from "@dpopsuev/alef-spine";
import { executeBindingChain, InProcessNerve, VALIDATE_REQUEST, VALIDATE_RESULT } from "@dpopsuev/alef-spine";
import { afterEach, describe, expect, it } from "vitest";

function makeNerve() {
	const nerve = new InProcessNerve();
	return { nerve, asNerve: () => nerve.asNerve() };
}

function stubEvaluator(
	nerve: InProcessNerve,
	organName: string,
	respond: (id: string) => { approved: boolean; feedback?: string },
) {
	return nerve.asNerve().motor.subscribe(VALIDATE_REQUEST, (event) => {
		const p = event.payload as { id: string; targetOrgan?: string };
		if (p.targetOrgan && p.targetOrgan !== organName) return;
		const { approved, feedback } = respond(p.id);
		nerve.asNerve().sense.publish({
			type: VALIDATE_RESULT,
			correlationId: event.correlationId,
			payload: { id: p.id, approved, feedback, reviewer: organName },
			isError: false,
		});
	});
}

describe("Binding chain — ordered", () => {
	const disposables: Array<() => void> = [];
	afterEach(() => {
		for (const d of disposables.splice(0)) d();
	});

	it("fires three stages in order, all approve", async () => {
		const { nerve } = makeNerve();
		const fired: string[] = [];

		disposables.push(
			stubEvaluator(nerve, "mechanical", (_id) => {
				fired.push("mechanical");
				return { approved: true };
			}),
		);
		disposables.push(
			stubEvaluator(nerve, "judge", (_id) => {
				fired.push("judge");
				return { approved: true };
			}),
		);
		disposables.push(
			stubEvaluator(nerve, "hitl", (_id) => {
				fired.push("hitl");
				return { approved: true };
			}),
		);

		const binding: Binding = {
			id: "test-chain",
			event: VALIDATE_REQUEST,
			mode: "ordered",
			chain: [{ organ: "mechanical" }, { organ: "judge" }, { organ: "hitl" }],
		};

		const result = await executeBindingChain(
			binding,
			{ output: { steps: ["do something"] } },
			nerve.asNerve(),
			"corr-1",
		);

		expect(result.approved).toBe(true);
		expect(fired).toEqual(["mechanical", "judge", "hitl"]);
	}, 10_000);

	it("short-circuits: mechanical rejects, stages 2+3 never fire", async () => {
		const { nerve } = makeNerve();
		const fired: string[] = [];

		disposables.push(
			stubEvaluator(nerve, "mechanical", () => {
				fired.push("mechanical");
				return { approved: false, feedback: "too short" };
			}),
		);
		disposables.push(
			stubEvaluator(nerve, "judge", () => {
				fired.push("judge");
				return { approved: true };
			}),
		);
		disposables.push(
			stubEvaluator(nerve, "hitl", () => {
				fired.push("hitl");
				return { approved: true };
			}),
		);

		const binding: Binding = {
			id: "short-circuit",
			event: VALIDATE_REQUEST,
			mode: "ordered",
			chain: [{ organ: "mechanical" }, { organ: "judge" }, { organ: "hitl" }],
		};

		const result = await executeBindingChain(binding, { output: {} }, nerve.asNerve(), "corr-2");

		expect(result.approved).toBe(false);
		expect(result.feedback).toBe("too short");
		expect(fired).toEqual(["mechanical"]);
	}, 10_000);
});

describe("Binding chain — parallel-all", () => {
	const disposables: Array<() => void> = [];
	afterEach(() => {
		for (const d of disposables.splice(0)) d();
	});

	it("both approve → approved", async () => {
		const { nerve } = makeNerve();
		disposables.push(stubEvaluator(nerve, "a", (_id) => ({ approved: true })));
		disposables.push(stubEvaluator(nerve, "b", (_id) => ({ approved: true })));

		const binding: Binding = {
			id: "par-all",
			event: VALIDATE_REQUEST,
			mode: "parallel-all",
			chain: [{ organ: "a" }, { organ: "b" }],
		};

		const result = await executeBindingChain(binding, { output: {} }, nerve.asNerve(), "corr-3");
		expect(result.approved).toBe(true);
	}, 10_000);

	it("one rejects → rejected", async () => {
		const { nerve } = makeNerve();
		disposables.push(stubEvaluator(nerve, "a", (_id) => ({ approved: true })));
		disposables.push(stubEvaluator(nerve, "b", (_id) => ({ approved: false, feedback: "b rejected" })));

		const binding: Binding = {
			id: "par-all-reject",
			event: VALIDATE_REQUEST,
			mode: "parallel-all",
			chain: [{ organ: "a" }, { organ: "b" }],
		};

		const result = await executeBindingChain(binding, { output: {} }, nerve.asNerve(), "corr-4");
		expect(result.approved).toBe(false);
	}, 10_000);
});
