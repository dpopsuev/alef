import type { Bus } from "@dpopsuev/alef-kernel/bus";
import { fauxAssistantMessage, registerFauxProvider } from "@dpopsuev/alef-ai/faux";
import { afterEach, describe, expect, it } from "vitest";
import { BusFixture, TurnDriver } from "../../testkit/src/index.js";
import { createAgentLoop } from "../src/index.js";

const OVERFLOW_ERROR = "prompt is too long: 213462 tokens > 200000 maximum";

describe("Reasoner — context overflow recovery", { tags: ["unit"] }, () => {
	const disposes: Array<() => void> = [];
	afterEach(() => {
		for (const d of disposes.splice(0)) d();
	});

	function makeOverflowHarness(faux: ReturnType<typeof registerFauxProvider>) {
		const f = new BusFixture();
		const driver = new TurnDriver(f.bus);
		const recorder = f.observe();
		const compactRequests: Array<Record<string, unknown>> = [];
		const overflowSignals: Array<Record<string, unknown>> = [];

		f.mount(
			createAgentLoop({
				model: faux.getModel(),
				apiKey: "faux-key",
				phaseTimeoutMs: 500,
				maxRetryDelayMs: 0,
			}),
		);

		const phaseAdapter = {
			name: "overflow-phase",
			description: "immediate assemble reply for overflow recovery tests",
			labels: [] as const,
			tools: [] as const,
			publishSchemas: {} as const,
			subscriptions: { command: ["context.assemble"] as const, event: [] as const, notification: [] as const },
			sources: [],
			mount(nerve: Bus) {
				nerve.command.subscribe("context.assemble", (event) => {
					nerve.event.publish({
						type: "context.assemble",
						payload: { messages: (event.payload as { messages: unknown[] }).messages },
						correlationId: event.correlationId,
						isError: false,
					});
				});
				nerve.notification.subscribe("context.compact.request", (event) => {
					compactRequests.push(event.payload as Record<string, unknown>);
				});
				nerve.notification.subscribe("context.overflow-recovery", (event) => {
					overflowSignals.push(event.payload as Record<string, unknown>);
				});
				return () => {};
			},
		};
		f.mount(phaseAdapter);
		disposes.push(() => f.dispose());

		return { driver, recorder, compactRequests, overflowSignals };
	}

	it("force-compacts once and retries LLM on context overflow", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW_ERROR }),
			fauxAssistantMessage("recovered after compact"),
		]);
		const { driver, compactRequests, overflowSignals } = makeOverflowHarness(faux);

		const reply = await driver.send("hi", "user", 5_000);

		expect(reply).toBe("recovered after compact");
		expect(faux.state.callCount).toBe(2);
		expect(compactRequests).toHaveLength(1);
		expect(typeof compactRequests[0]?.instructions).toBe("string");
		expect(overflowSignals).toEqual(
			expect.arrayContaining([expect.objectContaining({ willRetry: true })]),
		);
		expect(overflowSignals.some((signal) => signal.willRetry === false)).toBe(false);
	});

	it("fails after one compact-and-retry without looping", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW_ERROR }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW_ERROR }),
			fauxAssistantMessage("should never be reached"),
		]);
		const { driver, compactRequests, overflowSignals } = makeOverflowHarness(faux);

		const reply = await driver.send("hi", "user", 5_000);

		expect(faux.state.callCount).toBe(2);
		expect(compactRequests).toHaveLength(1);
		expect(overflowSignals.filter((signal) => signal.willRetry === true)).toHaveLength(1);
		expect(overflowSignals.filter((signal) => signal.willRetry === false)).toHaveLength(1);
		expect(reply).toContain("prompt is too long");
		expect(reply).not.toBe("should never be reached");
	});
});
