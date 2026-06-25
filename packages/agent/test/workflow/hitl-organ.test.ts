/**
 * HitlAdapter unit test.
 *
 * Verifies:
 *   - responds to validate.required when targetAdapter matches
 *   - skips events targeting a different adapter
 *   - approved result published on event/validate.result
 *   - rejected with feedback round-trips correctly
 *   - works end-to-end with a Binding chain
 */

import { VALIDATE_REQUEST, VALIDATE_RESULT } from "@dpopsuev/alef-kernel/adapter";
import { InProcessBus } from "@dpopsuev/alef-kernel/bus";
import { createHitlAdapter } from "@dpopsuev/alef-tool-workflow";
import { afterEach, describe, expect, it } from "vitest";

function makeBus() {
	const bus = new InProcessBus();
	return { bus, n: bus.asBus() };
}

describe("HitlAdapter", { tags: ["unit"] }, () => {
	const unmounts: Array<() => void> = [];
	afterEach(() => {
		for (const u of unmounts.splice(0)) u();
	});

	it("approves when onEvaluate returns approved:true", async () => {
		const { bus, n } = makeBus();
		const hitl = createHitlAdapter({
			onEvaluate: async () => ({ approved: true }),
		});
		unmounts.push(hitl.mount(n));

		const result = await new Promise<Record<string, unknown>>((resolve) => {
			n.event.subscribe(VALIDATE_RESULT, (e) => {
				if ((e.payload as { id: string }).id === "req-1") resolve(e.payload as Record<string, unknown>);
			});
			bus.asBus().command.publish({
				type: VALIDATE_REQUEST,
				correlationId: "corr-1",
				payload: { id: "req-1", output: { steps: ["do it"] }, targetAdapter: "hitl" },
			});
		});

		expect(result.approved).toBe(true);
		expect(result.reviewer).toBe("human");
	}, 5_000);

	it("rejects with feedback when onEvaluate returns approved:false", async () => {
		const { bus, n } = makeBus();
		const hitl = createHitlAdapter({
			onEvaluate: async () => ({ approved: false, feedback: "needs more detail" }),
		});
		unmounts.push(hitl.mount(n));

		const result = await new Promise<Record<string, unknown>>((resolve) => {
			n.event.subscribe(VALIDATE_RESULT, (e) => {
				if ((e.payload as { id: string }).id === "req-2") resolve(e.payload as Record<string, unknown>);
			});
			bus.asBus().command.publish({
				type: VALIDATE_REQUEST,
				correlationId: "corr-2",
				payload: { id: "req-2", output: {}, targetAdapter: "hitl" },
			});
		});

		expect(result.approved).toBe(false);
		expect(result.feedback).toBe("needs more detail");
	}, 5_000);

	it("ignores events targeting a different adapter", async () => {
		const { n } = makeBus();
		let called = false;
		const hitl = createHitlAdapter({
			onEvaluate: async () => {
				called = true;
				return { approved: true };
			},
		});
		unmounts.push(hitl.mount(n));

		n.command.publish({
			type: VALIDATE_REQUEST,
			correlationId: "corr-3",
			payload: { id: "req-3", output: {}, targetAdapter: "judge" },
		});

		await new Promise((r) => setTimeout(r, 50));
		expect(called).toBe(false);
	}, 5_000);

	it("receives question input and passes it to onEvaluate", async () => {
		const { bus, n } = makeBus();
		let received: unknown;
		const hitl = createHitlAdapter({
			onEvaluate: async (input: import("@dpopsuev/alef-tool-workflow").HitlEvaluateInput) => {
				received = input;
				return { approved: true };
			},
		});
		unmounts.push(hitl.mount(n));

		await new Promise<void>((resolve) => {
			n.event.subscribe(VALIDATE_RESULT, (e) => {
				if ((e.payload as { id: string }).id === "req-4") resolve();
			});
			bus.asBus().command.publish({
				type: VALIDATE_REQUEST,
				correlationId: "corr-4",
				payload: {
					id: "req-4",
					output: { plan: "fix the bug" },
					context: "Does this look right?",
					kind: "human",
					targetAdapter: "hitl",
				},
			});
		});

		expect(received).toMatchObject({ output: { plan: "fix the bug" }, context: "Does this look right?" });
	}, 5_000);
});
