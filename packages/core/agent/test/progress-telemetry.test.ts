import { describe, expect, it } from "vitest";
import { InProcessBus } from "@dpopsuev/alef-kernel/bus";
import { newCorrelationId } from "@dpopsuev/alef-kernel/bus";
import { computeTokPerProgress, ProgressTelemetry } from "../src/progress-telemetry.js";

describe("computeTokPerProgress", { tags: ["unit"] }, () => {
	it("returns null progress when gap missing", () => {
		expect(computeTokPerProgress(100, null, 1)).toEqual({ progress: null, tokPerProgress: null });
		expect(computeTokPerProgress(100, 2, null)).toEqual({ progress: null, tokPerProgress: null });
	});

	it("computes P and tok/P when gap shrinks", () => {
		expect(computeTokPerProgress(50, 10, 5)).toEqual({ progress: 5, tokPerProgress: 10 });
	});

	it("zero progress when gap grows or flat", () => {
		expect(computeTokPerProgress(50, 5, 5)).toEqual({ progress: 0, tokPerProgress: null });
		expect(computeTokPerProgress(50, 5, 8)).toEqual({ progress: 0, tokPerProgress: null });
	});
});

describe("ProgressTelemetry", { tags: ["unit"] }, () => {
	it("emits step with P=null when no DSS/gap", () => {
		const root = new InProcessBus();
		const bus = root.asBus();
		const steps: Array<Record<string, unknown>> = [];
		bus.notification.subscribe("telemetry.progress.step", (event) => {
			steps.push(event.payload);
		});
		const meter = new ProgressTelemetry();
		const unmount = meter.mount(bus);
		const correlationId = newCorrelationId();

		bus.event.publish({ type: "llm.input", payload: { text: "hi" }, correlationId, isError: false });
		bus.notification.publish({
			type: "llm.token-usage",
			payload: { usage: { input: 10, output: 5, totalTokens: 15 } },
			correlationId,
		});
		bus.command.publish({ type: "llm.response", payload: { text: "ok" }, correlationId });

		expect(steps).toHaveLength(1);
		expect(steps[0]!.tokens).toBe(15);
		expect(steps[0]!.progress).toBeNull();
		expect(steps[0]!.tok_per_progress).toBeNull();
		unmount();
	});

	it("emits step tok/P when gap shrinks and outcome on converge", () => {
		let gap = 10;
		const root = new InProcessBus();
		const bus = root.asBus();
		const steps: Array<Record<string, unknown>> = [];
		const outcomes: Array<Record<string, unknown>> = [];
		bus.notification.subscribe("telemetry.progress.step", (event) => {
			steps.push(event.payload);
		});
		bus.notification.subscribe("telemetry.progress.outcome", (event) => {
			outcomes.push(event.payload);
		});

		const meter = new ProgressTelemetry({
			getGap: () => ({ totalMagnitude: gap, converged: gap === 0 }),
		});
		const unmount = meter.mount(bus);
		const correlationId = newCorrelationId();

		bus.event.publish({ type: "llm.input", payload: { text: "hi" }, correlationId, isError: false });
		gap = 4;
		bus.notification.publish({
			type: "llm.token-usage",
			payload: { usage: { input: 20, output: 10, totalTokens: 30 } },
			correlationId,
		});
		bus.command.publish({ type: "llm.response", payload: { text: "ok" }, correlationId });

		expect(steps).toHaveLength(1);
		expect(steps[0]!.gap_before).toBe(10);
		expect(steps[0]!.gap_after).toBe(4);
		expect(steps[0]!.progress).toBe(6);
		expect(steps[0]!.tok_per_progress).toBe(5);
		expect(outcomes).toHaveLength(0);

		const correlationId2 = newCorrelationId();
		bus.event.publish({ type: "llm.input", payload: { text: "again" }, correlationId: correlationId2, isError: false });
		gap = 0;
		bus.notification.publish({
			type: "llm.token-usage",
			payload: { usage: { input: 4, output: 2, totalTokens: 6 } },
			correlationId: correlationId2,
		});
		bus.command.publish({ type: "llm.response", payload: { text: "done" }, correlationId: correlationId2 });

		expect(steps).toHaveLength(2);
		expect(steps[1]!.progress).toBe(4);
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]!.steps).toBe(2);
		expect(outcomes[0]!.converged).toBe(true);
		expect(outcomes[0]!.tokens).toBe(36);
		unmount();
	});
});
