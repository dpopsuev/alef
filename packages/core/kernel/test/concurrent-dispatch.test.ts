import { describe, expect, it } from "vitest";
import type { EventMessage } from "../src/buses.js";
import type { CommandHandlerCtx } from "../src/framework.js";
import { defineAdapter } from "../src/framework.js";
import { InProcessBus } from "../src/in-process-bus.js";

function makeBus() {
	const bus = new InProcessBus();
	return { bus, n: bus.asBus() };
}

function waitEvent(bus: InProcessBus, type: string, correlationId: string): Promise<EventMessage> {
	return new Promise((resolve) => {
		const off = bus.asBus().event.subscribe(type, (event) => {
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
		const { bus, n } = makeBus();

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

		const responsePromises = correlationIds.map((correlationId) => waitEvent(bus, "echo.ping", correlationId));

		await Promise.all(
			correlationIds.map((correlationId, index) =>
				Promise.resolve(bus.asBus().command.publish({ type: "echo.ping", payload: { index }, correlationId })),
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
		const { bus, n } = makeBus();

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

		const responsePromises = correlationIds.map((correlationId) => waitEvent(bus, "identity.reflect", correlationId));

		await Promise.all(
			inputs.map((value, i) =>
				Promise.resolve(
					bus.asBus().command.publish({
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
		const { bus, n } = makeBus();

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
		const errorPromise = waitEvent(bus, "fragile.op", "corr-fail");
		bus.asBus().command.publish({ type: "fragile.op", payload: { fail: true }, correlationId: "corr-fail" });
		const errorResult = await errorPromise;

		expect(errorResult.correlationId).toBe("corr-fail");
		expect(errorResult.isError).toBe(true);
		expect(errorResult.errorMessage).toBe("intentional failure");

		// Second call: bus must still be healthy
		const successPromise = waitEvent(bus, "fragile.op", "corr-ok");
		bus.asBus().command.publish({ type: "fragile.op", payload: { fail: false }, correlationId: "corr-ok" });
		const successResult = await successPromise;

		expect(successResult.correlationId).toBe("corr-ok");
		expect(successResult.isError).toBe(false);
		expect(successResult.payload.ok).toBe(true);
	});
});
