import { InProcessNerve } from "@dpopsuev/alef-spine";
import { describe, expect, it, vi } from "vitest";
import { LoopDetectorOrgan } from "../src/loop-detector.js";

describe("LoopDetectorOrgan", () => {
	it("exposes organ interface", () => {
		const organ = new LoopDetectorOrgan();
		expect(organ.name).toBe("loop-detector");
		expect(organ.tools).toHaveLength(0);
		expect(organ.subscriptions.motor).toContain("*");
	});

	it("does not fire for distinct event types", async () => {
		const onLoop = vi.fn();
		const organ = new LoopDetectorOrgan({ threshold: 3, onLoop });
		const nerve = new InProcessNerve();
		organ.mount(nerve.asNerve());

		for (const type of ["fs.read", "fs.write", "shell.exec", "fs.grep", "fs.find"]) {
			nerve.asNerve().motor.publish({
				type,
				payload: { toolCallId: "t1" },
				correlationId: "corr-1",
				timestamp: Date.now(),
			});
		}

		expect(onLoop).not.toHaveBeenCalled();
	});

	it("fires when same event type exceeds threshold", async () => {
		const onLoop = vi.fn();
		const organ = new LoopDetectorOrgan({ threshold: 3, onLoop });
		const nerve = new InProcessNerve();
		organ.mount(nerve.asNerve());

		for (let i = 0; i < 5; i++) {
			nerve.asNerve().motor.publish({
				type: "fs.read",
				payload: { toolCallId: `t${i}` },
				correlationId: "corr-1",
				timestamp: Date.now(),
			});
		}

		expect(onLoop).toHaveBeenCalled();
		expect(onLoop.mock.calls[0][0]).toBe("fs.read");
	});

	it("resets counts on new correlationId", () => {
		const onLoop = vi.fn();
		const organ = new LoopDetectorOrgan({ threshold: 3, onLoop });
		const nerve = new InProcessNerve();
		organ.mount(nerve.asNerve());

		// Fire 3 times under corr-1 (at threshold, not over)
		for (let i = 0; i < 3; i++) {
			nerve.asNerve().motor.publish({
				type: "fs.read",
				payload: { toolCallId: `t${i}` },
				correlationId: "corr-1",
				timestamp: Date.now(),
			});
		}

		// New correlation — counter resets
		for (let i = 0; i < 3; i++) {
			nerve.asNerve().motor.publish({
				type: "fs.read",
				payload: { toolCallId: `t${i}` },
				correlationId: "corr-2",
				timestamp: Date.now(),
			});
		}

		expect(onLoop).not.toHaveBeenCalled();
	});

	it("unmount stops observing", () => {
		const onLoop = vi.fn();
		const organ = new LoopDetectorOrgan({ threshold: 2, onLoop });
		const nerve = new InProcessNerve();
		const unmount = organ.mount(nerve.asNerve());
		unmount();

		for (let i = 0; i < 5; i++) {
			nerve.asNerve().motor.publish({
				type: "fs.read",
				payload: { toolCallId: `t${i}` },
				correlationId: "corr-1",
				timestamp: Date.now(),
			});
		}

		expect(onLoop).not.toHaveBeenCalled();
	});
});
