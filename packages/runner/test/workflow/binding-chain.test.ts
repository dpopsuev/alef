/**
 * Binding chain test: ordered mechanical → LLM → human evaluators.
 *
 * Verifies:
 *   - three-stage ordered chain fires in sequence
 *   - each stage self-selects via targetAdapter
 *   - short-circuit: mechanical rejection skips stages 2 and 3
 *   - parallel-all mode: both must approve
 */

import type { Binding } from "@dpopsuev/alef-kernel";
import { executeBindingChain, InProcessBus, VALIDATE_REQUEST, VALIDATE_RESULT } from "@dpopsuev/alef-kernel";
import { afterEach, describe, expect, it } from "vitest";

function makeBus() {
	const bus = new InProcessBus();
	return { bus, asBus: () => bus.asBus() };
}

function stubEvaluator(
	bus: InProcessBus,
	adapterName: string,
	respond: (id: string) => { approved: boolean; feedback?: string },
) {
	return bus.asBus().command.subscribe(VALIDATE_REQUEST, (event) => {
		const p = event.payload as { id: string; targetAdapter?: string };
		if (p.targetAdapter && p.targetAdapter !== adapterName) return;
		const { approved, feedback } = respond(p.id);
		bus.asBus().event.publish({
			type: VALIDATE_RESULT,
			correlationId: event.correlationId,
			payload: { id: p.id, approved, feedback, reviewer: adapterName },
			isError: false,
		});
	});
}

describe("Binding chain — ordered", { tags: ["unit"] }, () => {
	const disposables: Array<() => void> = [];
	afterEach(() => {
		for (const d of disposables.splice(0)) d();
	});

	it("fires three stages in order, all approve", async () => {
		const { bus } = makeBus();
		const fired: string[] = [];

		disposables.push(
			stubEvaluator(bus, "mechanical", (_id) => {
				fired.push("mechanical");
				return { approved: true };
			}),
		);
		disposables.push(
			stubEvaluator(bus, "judge", (_id) => {
				fired.push("judge");
				return { approved: true };
			}),
		);
		disposables.push(
			stubEvaluator(bus, "hitl", (_id) => {
				fired.push("hitl");
				return { approved: true };
			}),
		);

		const binding: Binding = {
			id: "test-chain",
			event: VALIDATE_REQUEST,
			mode: "ordered",
			chain: [{ adapter: "mechanical" }, { adapter: "judge" }, { adapter: "hitl" }],
		};

		const result = await executeBindingChain(binding, { output: { steps: ["do something"] } }, bus.asBus(), "corr-1");

		expect(result.approved).toBe(true);
		expect(fired).toEqual(["mechanical", "judge", "hitl"]);
	}, 10_000);

	it("short-circuits: mechanical rejects, stages 2+3 never fire", async () => {
		const { bus } = makeBus();
		const fired: string[] = [];

		disposables.push(
			stubEvaluator(bus, "mechanical", () => {
				fired.push("mechanical");
				return { approved: false, feedback: "too short" };
			}),
		);
		disposables.push(
			stubEvaluator(bus, "judge", () => {
				fired.push("judge");
				return { approved: true };
			}),
		);
		disposables.push(
			stubEvaluator(bus, "hitl", () => {
				fired.push("hitl");
				return { approved: true };
			}),
		);

		const binding: Binding = {
			id: "short-circuit",
			event: VALIDATE_REQUEST,
			mode: "ordered",
			chain: [{ adapter: "mechanical" }, { adapter: "judge" }, { adapter: "hitl" }],
		};

		const result = await executeBindingChain(binding, { output: {} }, bus.asBus(), "corr-2");

		expect(result.approved).toBe(false);
		expect(result.feedback).toBe("too short");
		expect(fired).toEqual(["mechanical"]);
	}, 10_000);
});

describe("Binding chain — parallel-all", { tags: ["unit"] }, () => {
	const disposables: Array<() => void> = [];
	afterEach(() => {
		for (const d of disposables.splice(0)) d();
	});

	it("both approve → approved", async () => {
		const { bus } = makeBus();
		disposables.push(stubEvaluator(bus, "a", (_id) => ({ approved: true })));
		disposables.push(stubEvaluator(bus, "b", (_id) => ({ approved: true })));

		const binding: Binding = {
			id: "par-all",
			event: VALIDATE_REQUEST,
			mode: "parallel-all",
			chain: [{ adapter: "a" }, { adapter: "b" }],
		};

		const result = await executeBindingChain(binding, { output: {} }, bus.asBus(), "corr-3");
		expect(result.approved).toBe(true);
	}, 10_000);

	it("one rejects → rejected", async () => {
		const { bus } = makeBus();
		disposables.push(stubEvaluator(bus, "a", (_id) => ({ approved: true })));
		disposables.push(stubEvaluator(bus, "b", (_id) => ({ approved: false, feedback: "b rejected" })));

		const binding: Binding = {
			id: "par-all-reject",
			event: VALIDATE_REQUEST,
			mode: "parallel-all",
			chain: [{ adapter: "a" }, { adapter: "b" }],
		};

		const result = await executeBindingChain(binding, { output: {} }, bus.asBus(), "corr-4");
		expect(result.approved).toBe(false);
	}, 10_000);
});
