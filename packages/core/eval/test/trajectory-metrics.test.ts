import { describe, expect, it } from "vitest";
import type { BusEvent } from "../src/metrics.js";
import {
	computeTrajectoryMetrics,
	factorialCellKey,
	formatTrajectoryMetricsLine,
	rankingReversal,
} from "../src/trajectory-metrics.js";

function toolEnd(ok: boolean, elapsedMs?: number): BusEvent {
	return {
		bus: "event",
		event: "llm.tool-end",
		correlationId: "c",
		payload: { ok },
		...(ok ? {} : { isError: true }),
		...(elapsedMs !== undefined && { elapsedMs }),
	};
}

function response(): BusEvent {
	return { bus: "event", event: "llm.response", correlationId: "c" };
}

describe("trajectory metrics", { tags: ["unit"] }, () => {
	it("returns null RR when there are no tool errors", () => {
		const metrics = computeTrajectoryMetrics([toolEnd(true)]);
		expect(metrics.recoveryRateK).toBeNull();
		expect(metrics.toolErrorCount).toBe(0);
		expect(formatTrajectoryMetricsLine(metrics)).toContain("RR=n/a");
	});

	it("computes RR(k) when a success follows an error within k turns", () => {
		const bus: BusEvent[] = [toolEnd(false, 10), response(), toolEnd(true, 40), response()];
		const metrics = computeTrajectoryMetrics(bus, [], 3);
		expect(metrics.toolErrorCount).toBe(1);
		expect(metrics.recoveredCount).toBe(1);
		expect(metrics.recoveryRateK).toBe(1);
		expect(metrics.controlLagMs).toBe(30);
	});

	it("does not count recovery outside the window", () => {
		const bus: BusEvent[] = [
			toolEnd(false),
			response(),
			response(),
			response(),
			response(),
			toolEnd(true),
		];
		const metrics = computeTrajectoryMetrics(bus, [], 2);
		expect(metrics.recoveredCount).toBe(0);
		expect(metrics.recoveryRateK).toBe(0);
	});

	it("factorial helpers support ranking reversals", () => {
		const keyA = factorialCellKey("summarize", "m1");
		const keyB = factorialCellKey("attention", "m1");
		const rates = new Map([
			[keyA, 0.9],
			[keyB, 0.4],
		]);
		expect(rankingReversal(rates, keyA, keyB, "a_beats_b")).toBe(false);
		expect(rankingReversal(rates, keyA, keyB, "b_beats_a")).toBe(true);
	});
});
