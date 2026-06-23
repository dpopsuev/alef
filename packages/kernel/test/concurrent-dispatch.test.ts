import { describe, expect, it } from "vitest";
import type { EventMessage } from "../src/buses.js";
import type { CommandHandlerCtx } from "../src/framework.js";
import { defineAdapter } from "../src/framework.js";
import { InProcessNerve } from "../src/in-process-nerve.js";

function makeNerve() {
	const nerve = new InProcessNerve();
	return { nerve, n: nerve.asBus() };
}

function waitEvent(nerve: InProcessNerve, type: string, correlationId: string): Promise<EventMessage> {
	return new Promise((resolve) => {
		const off = nerve.asBus().event.subscribe(type, (event) => {
			if (event.correlationId !== correlationId) return;
			off();
			resolve(event);
		});
	});
}

// ---------------------------------------------------------------------------
// concurrent adapter dispatch
// ---------------------------------------------------------------------------

describe("concurrent adapter dispatch", { tags: ["unit"] }, () => {
	it("5 concurrent command messages → 5 event responses with correct correlationIds", async () => {
		const { nerve, n } = makeNerve();

		defineAdapter("echo", {
			command: {
				"echo.ping": {
					async *handle(ctx: CommandHandlerCtx) {
						yield { echoed: ctx.payload.index };
					},
				},
			},
		}).mount(n);

		const correlationIds = Array.from({ length: 5 }, (_, i) => `corr-${i}`);

		const responsePromises = correlationIds.map((correlationId) => waitEvent(nerve, "echo.ping", correlationId));

		await Promise.all(
			correlationIds.map((correlationId, index) =>
				Promise.resolve(nerve.asBus().command.publish({ type: "echo.ping", payload: { index }, correlationId })),
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

		defineAdapter("identity", {
			command: {
				"identity.reflect": {
					async *handle(ctx: CommandHandlerCtx) {
						yield { value: ctx.payload.value };
					},
				},
			},
		}).mount(n);

		const inputs = ["alpha", "beta", "gamma", "delta", "epsilon"];
		const correlationIds = inputs.map((_, i) => `id-corr-${i}`);

		const responsePromises = correlationIds.map((correlationId) =>
			waitEvent(nerve, "identity.reflect", correlationId),
		);

		await Promise.all(
			inputs.map((value, i) =>
				Promise.resolve(
					nerve.asBus().command.publish({
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

	it("adapter throws → error event carries correct correlationId, nerve stays healthy", async () => {
		const { nerve, n } = makeNerve();

		defineAdapter("fragile", {
			command: {
				"fragile.op": {
					async *handle(ctx: CommandHandlerCtx) {
						if (ctx.payload.fail) throw new Error("intentional failure");
						yield { ok: true };
					},
				},
			},
		}).mount(n);

		// First call: error path
		const errorPromise = waitEvent(nerve, "fragile.op", "corr-fail");
		nerve.asBus().command.publish({ type: "fragile.op", payload: { fail: true }, correlationId: "corr-fail" });
		const errorResult = await errorPromise;

		expect(errorResult.correlationId).toBe("corr-fail");
		expect(errorResult.isError).toBe(true);
		expect(errorResult.errorMessage).toBe("intentional failure");

		// Second call: nerve must still be healthy
		const successPromise = waitEvent(nerve, "fragile.op", "corr-ok");
		nerve.asBus().command.publish({ type: "fragile.op", payload: { fail: false }, correlationId: "corr-ok" });
		const successResult = await successPromise;

		expect(successResult.correlationId).toBe("corr-ok");
		expect(successResult.isError).toBe(false);
		expect(successResult.payload.ok).toBe(true);
	});
});
