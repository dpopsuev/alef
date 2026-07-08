import { describe, expect, it } from "vitest";
import { type ActualConditions, computeError, type DesiredStateSpec, detectDrift } from "../src/reconciliation.js";

describe("computeError", { tags: ["unit"] }, () => {
	const dss: DesiredStateSpec = {
		intent: "create a hello.ts file",
		dimensions: [
			{ domain: "fs", key: "hello.ts.exists", target: true, priority: 1 },
			{ domain: "fs", key: "hello.ts.content", target: 'console.log("hello")', priority: 0.5 },
		],
	};

	it("returns full error when no conditions reported", () => {
		const error = computeError(dss, []);
		expect(error.totalMagnitude).toBe(2);
		expect(error.converged).toBe(false);
		expect(error.dimensions).toHaveLength(2);
	});

	it("returns zero error when all conditions match", () => {
		const ac: ActualConditions = {
			adapterId: "fs",
			healthy: true,
			observedAt: Date.now(),
			conditions: [
				{ domain: "fs", key: "hello.ts.exists", value: true, confidence: 1, observedAt: Date.now() },
				{
					domain: "fs",
					key: "hello.ts.content",
					value: 'console.log("hello")',
					confidence: 1,
					observedAt: Date.now(),
				},
			],
		};
		const error = computeError(dss, [ac]);
		expect(error.totalMagnitude).toBe(0);
		expect(error.converged).toBe(true);
	});

	it("returns partial error for partial match", () => {
		const ac: ActualConditions = {
			adapterId: "fs",
			healthy: true,
			observedAt: Date.now(),
			conditions: [
				{ domain: "fs", key: "hello.ts.exists", value: true, confidence: 1, observedAt: Date.now() },
				{ domain: "fs", key: "hello.ts.content", value: "wrong content", confidence: 1, observedAt: Date.now() },
			],
		};
		const error = computeError(dss, [ac]);
		expect(error.totalMagnitude).toBe(0.5);
		expect(error.converged).toBe(false);
	});
});

describe("detectDrift", { tags: ["unit"] }, () => {
	it("detects dimensions that went from converged to diverged", () => {
		const previous = computeError(
			{ intent: "test", dimensions: [{ domain: "fs", key: "exists", target: true, priority: 1 }] },
			[
				{
					adapterId: "fs",
					healthy: true,
					observedAt: 0,
					conditions: [{ domain: "fs", key: "exists", value: true, confidence: 1, observedAt: 0 }],
				},
			],
		);
		const current = computeError(
			{ intent: "test", dimensions: [{ domain: "fs", key: "exists", target: true, priority: 1 }] },
			[
				{
					adapterId: "fs",
					healthy: true,
					observedAt: 1,
					conditions: [{ domain: "fs", key: "exists", value: false, confidence: 1, observedAt: 1 }],
				},
			],
		);
		const drift = detectDrift(previous, current);
		expect(drift).toHaveLength(1);
		expect(drift[0]!.key).toBe("exists");
	});
});
