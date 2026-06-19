import { describe, expect, it } from "vitest";
import type { SenseEvent } from "../src/buses.js";
import type { MotorHandlerCtx } from "../src/framework.js";
import { defineOrgan } from "../src/framework.js";
import { InProcessNerve } from "../src/in-process-nerve.js";

function makeNerve() {
	const nerve = new InProcessNerve();
	return { nerve, n: nerve.asNerve() };
}

function waitSense(nerve: InProcessNerve, type: string, correlationId: string): Promise<SenseEvent> {
	return new Promise((resolve) => {
		const off = nerve.asNerve().sense.subscribe(type, (event) => {
			if (event.correlationId !== correlationId) return;
			off();
			resolve(event);
		});
	});
}

// ---------------------------------------------------------------------------
// concurrent organ dispatch
// ---------------------------------------------------------------------------

describe("concurrent organ dispatch", { tags: ["unit"] }, () => {
	it("5 concurrent motor events → 5 sense responses with correct correlationIds", async () => {
		const { nerve, n } = makeNerve();

		defineOrgan("echo", {
			motor: {
				"echo.ping": {
					async *handle(ctx: MotorHandlerCtx) {
						yield { echoed: ctx.payload.index };
					},
				},
			},
		}).mount(n);

		const correlationIds = Array.from({ length: 5 }, (_, i) => `corr-${i}`);

		const responsePromises = correlationIds.map((correlationId) => waitSense(nerve, "echo.ping", correlationId));

		await Promise.all(
			correlationIds.map((correlationId, index) =>
				Promise.resolve(nerve.asNerve().motor.publish({ type: "echo.ping", payload: { index }, correlationId })),
			),
		);

		const responses = await Promise.all(responsePromises);

		for (let i = 0; i < 5; i++) {
			expect(responses[i].correlationId).toBe(`corr-${i}`);
			expect(responses[i].isError).toBe(false);
			expect(responses[i].payload.echoed).toBe(i);
		}
	});

	it("no cross-contamination: each response carries only its own payload", async () => {
		const { nerve, n } = makeNerve();

		defineOrgan("identity", {
			motor: {
				"identity.reflect": {
					async *handle(ctx: MotorHandlerCtx) {
						yield { value: ctx.payload.value };
					},
				},
			},
		}).mount(n);

		const inputs = ["alpha", "beta", "gamma", "delta", "epsilon"];
		const correlationIds = inputs.map((_, i) => `id-corr-${i}`);

		const responsePromises = correlationIds.map((correlationId) =>
			waitSense(nerve, "identity.reflect", correlationId),
		);

		await Promise.all(
			inputs.map((value, i) =>
				Promise.resolve(
					nerve.asNerve().motor.publish({
						type: "identity.reflect",
						payload: { value },
						correlationId: correlationIds[i],
					}),
				),
			),
		);

		const responses = await Promise.all(responsePromises);

		for (let i = 0; i < inputs.length; i++) {
			expect(responses[i].correlationId).toBe(correlationIds[i]);
			expect(responses[i].payload.value).toBe(inputs[i]);
		}
	});

	it("organ throws → error sense carries correct correlationId, nerve stays healthy", async () => {
		const { nerve, n } = makeNerve();

		defineOrgan("fragile", {
			motor: {
				"fragile.op": {
					async *handle(ctx: MotorHandlerCtx) {
						if (ctx.payload.fail) throw new Error("intentional failure");
						yield { ok: true };
					},
				},
			},
		}).mount(n);

		// First call: error path
		const errorPromise = waitSense(nerve, "fragile.op", "corr-fail");
		nerve.asNerve().motor.publish({ type: "fragile.op", payload: { fail: true }, correlationId: "corr-fail" });
		const errorResult = await errorPromise;

		expect(errorResult.correlationId).toBe("corr-fail");
		expect(errorResult.isError).toBe(true);
		expect(errorResult.errorMessage).toBe("intentional failure");

		// Second call: nerve must still be healthy
		const successPromise = waitSense(nerve, "fragile.op", "corr-ok");
		nerve.asNerve().motor.publish({ type: "fragile.op", payload: { fail: false }, correlationId: "corr-ok" });
		const successResult = await successPromise;

		expect(successResult.correlationId).toBe("corr-ok");
		expect(successResult.isError).toBe(false);
		expect(successResult.payload.ok).toBe(true);
	});
});
