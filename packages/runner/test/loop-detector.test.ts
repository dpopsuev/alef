import { InProcessNerve } from "@dpopsuev/alef-spine";
import { describe, expect, it, vi } from "vitest";
import { LoopDetectorOrgan } from "../src/loop-detector.js";

function publish(nerve: InProcessNerve, type: string, args: Record<string, unknown>, corr = "corr-1") {
	nerve.asNerve().motor.publish({ type, payload: { toolCallId: `t-${Math.random()}`, ...args }, correlationId: corr });
}

describe("LoopDetectorOrgan", () => {
	it("exposes organ interface", () => {
		const organ = new LoopDetectorOrgan();
		expect(organ.name).toBe("loop-detector");
		expect(organ.tools).toHaveLength(0);
		expect(organ.subscriptions.motor).toContain("*");
	});

	it("does not fire for many calls to the same tool with different args", () => {
		const onLoop = vi.fn();
		const organ = new LoopDetectorOrgan({ repeatedArgThreshold: 3, onLoop });
		const nerve = new InProcessNerve();
		organ.mount(nerve.asNerve());

		// 10 fs.read calls — all different paths — not a loop
		for (let i = 0; i < 10; i++) {
			publish(nerve, "fs.read", { path: `file${i}.ts` });
		}

		expect(onLoop).not.toHaveBeenCalled();
	});

	it("fires when the same tool is called with identical args more than repeatedArgThreshold times", () => {
		const onLoop = vi.fn();
		const organ = new LoopDetectorOrgan({ repeatedArgThreshold: 2, onLoop });
		const nerve = new InProcessNerve();
		organ.mount(nerve.asNerve());

		// Call fs.read with the same path 3 times — exceeds threshold of 2
		for (let i = 0; i < 3; i++) {
			publish(nerve, "fs.read", { path: "README.md" });
		}

		expect(onLoop).toHaveBeenCalledOnce();
		expect(onLoop.mock.calls[0][0]).toBe("fs.read");
		expect(onLoop.mock.calls[0][1]).toContain("identical arguments");
	});

	it("does not fire when same tool is called with identical args exactly at threshold", () => {
		const onLoop = vi.fn();
		const organ = new LoopDetectorOrgan({ repeatedArgThreshold: 3, onLoop });
		const nerve = new InProcessNerve();
		organ.mount(nerve.asNerve());

		for (let i = 0; i < 3; i++) {
			publish(nerve, "fs.read", { path: "README.md" });
		}

		expect(onLoop).not.toHaveBeenCalled();
	});

	it("fires safety net when total calls for one tool exceed totalCallThreshold", () => {
		const onLoop = vi.fn();
		const organ = new LoopDetectorOrgan({ totalCallThreshold: 5, onLoop });
		const nerve = new InProcessNerve();
		organ.mount(nerve.asNerve());

		// 6 calls with different args — each unique, but total exceeds 5
		for (let i = 0; i < 6; i++) {
			publish(nerve, "fs.read", { path: `unique-file-${i}.ts` });
		}

		expect(onLoop).toHaveBeenCalled();
		expect(onLoop.mock.calls[0][1]).toContain("limit:");
	});

	it("resets counts on new correlationId", () => {
		const onLoop = vi.fn();
		const organ = new LoopDetectorOrgan({ repeatedArgThreshold: 2, onLoop });
		const nerve = new InProcessNerve();
		organ.mount(nerve.asNerve());

		// 2 identical calls under corr-1 (at threshold, not over)
		for (let i = 0; i < 2; i++) {
			publish(nerve, "fs.read", { path: "README.md" }, "corr-1");
		}

		// New correlation — counters reset, 2 more identical calls should not fire
		for (let i = 0; i < 2; i++) {
			publish(nerve, "fs.read", { path: "README.md" }, "corr-2");
		}

		expect(onLoop).not.toHaveBeenCalled();
	});

	it("unmount stops observing", () => {
		const onLoop = vi.fn();
		const organ = new LoopDetectorOrgan({ repeatedArgThreshold: 2, onLoop });
		const nerve = new InProcessNerve();
		const unmount = organ.mount(nerve.asNerve());
		unmount();

		for (let i = 0; i < 5; i++) {
			publish(nerve, "fs.read", { path: "README.md" });
		}

		expect(onLoop).not.toHaveBeenCalled();
	});

	it("counts arg-hash correctly: toolCallId is stripped before hashing", () => {
		const onLoop = vi.fn();
		// Each call has a different toolCallId but the same path — should detect loop
		const organ = new LoopDetectorOrgan({ repeatedArgThreshold: 2, onLoop });
		const nerve = new InProcessNerve();
		organ.mount(nerve.asNerve());

		// publish() already generates a unique toolCallId per call
		for (let i = 0; i < 3; i++) {
			publish(nerve, "fs.read", { path: "same-file.ts" });
		}

		expect(onLoop).toHaveBeenCalledOnce();
	});
});
