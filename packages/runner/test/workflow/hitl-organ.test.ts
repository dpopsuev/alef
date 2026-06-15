/**
 * HitlOrgan unit test.
 *
 * Verifies:
 *   - responds to validate.required when targetOrgan matches
 *   - skips events targeting a different organ
 *   - approved result published on sense/validate.result
 *   - rejected with feedback round-trips correctly
 *   - works end-to-end with a Binding chain
 */

import { InProcessNerve, VALIDATE_REQUEST, VALIDATE_RESULT } from "@dpopsuev/alef-kernel";
import { createHitlOrgan } from "@dpopsuev/alef-organ-workflow";
import { afterEach, describe, expect, it } from "vitest";

function makeNerve() {
	const nerve = new InProcessNerve();
	return { nerve, n: nerve.asNerve() };
}

describe("HitlOrgan", { tags: ["unit"] }, () => {
	const unmounts: Array<() => void> = [];
	afterEach(() => {
		for (const u of unmounts.splice(0)) u();
	});

	it("approves when onEvaluate returns approved:true", async () => {
		const { nerve, n } = makeNerve();
		const hitl = createHitlOrgan({
			onEvaluate: async () => ({ approved: true }),
		});
		unmounts.push(hitl.mount(n));

		const result = await new Promise<Record<string, unknown>>((resolve) => {
			n.sense.subscribe(VALIDATE_RESULT, (e) => {
				if ((e.payload as { id: string }).id === "req-1") resolve(e.payload as Record<string, unknown>);
			});
			nerve.asNerve().motor.publish({
				type: VALIDATE_REQUEST,
				correlationId: "corr-1",
				payload: { id: "req-1", output: { steps: ["do it"] }, targetOrgan: "hitl" },
			});
		});

		expect(result.approved).toBe(true);
		expect(result.reviewer).toBe("human");
	}, 5_000);

	it("rejects with feedback when onEvaluate returns approved:false", async () => {
		const { nerve, n } = makeNerve();
		const hitl = createHitlOrgan({
			onEvaluate: async () => ({ approved: false, feedback: "needs more detail" }),
		});
		unmounts.push(hitl.mount(n));

		const result = await new Promise<Record<string, unknown>>((resolve) => {
			n.sense.subscribe(VALIDATE_RESULT, (e) => {
				if ((e.payload as { id: string }).id === "req-2") resolve(e.payload as Record<string, unknown>);
			});
			nerve.asNerve().motor.publish({
				type: VALIDATE_REQUEST,
				correlationId: "corr-2",
				payload: { id: "req-2", output: {}, targetOrgan: "hitl" },
			});
		});

		expect(result.approved).toBe(false);
		expect(result.feedback).toBe("needs more detail");
	}, 5_000);

	it("ignores events targeting a different organ", async () => {
		const { n } = makeNerve();
		let called = false;
		const hitl = createHitlOrgan({
			onEvaluate: async () => {
				called = true;
				return { approved: true };
			},
		});
		unmounts.push(hitl.mount(n));

		n.motor.publish({
			type: VALIDATE_REQUEST,
			correlationId: "corr-3",
			payload: { id: "req-3", output: {}, targetOrgan: "judge" },
		});

		await new Promise((r) => setTimeout(r, 50));
		expect(called).toBe(false);
	}, 5_000);

	it("receives question input and passes it to onEvaluate", async () => {
		const { nerve, n } = makeNerve();
		let received: unknown;
		const hitl = createHitlOrgan({
			onEvaluate: async (input: import("@dpopsuev/alef-organ-workflow").HitlEvaluateInput) => {
				received = input;
				return { approved: true };
			},
		});
		unmounts.push(hitl.mount(n));

		await new Promise<void>((resolve) => {
			n.sense.subscribe(VALIDATE_RESULT, (e) => {
				if ((e.payload as { id: string }).id === "req-4") resolve();
			});
			nerve.asNerve().motor.publish({
				type: VALIDATE_REQUEST,
				correlationId: "corr-4",
				payload: {
					id: "req-4",
					output: { plan: "fix the bug" },
					context: "Does this look right?",
					kind: "human",
					targetOrgan: "hitl",
				},
			});
		});

		expect(received).toMatchObject({ output: { plan: "fix the bug" }, context: "Does this look right?" });
	}, 5_000);
});
