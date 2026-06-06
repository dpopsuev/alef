import { InProcessNerve } from "@dpopsuev/alef-kernel";
import { describe, expect, it, vi } from "vitest";
import { LoopGuard } from "../src/loop-detector.js";

/** Publish a motor event and its matching sense result (full interaction). */
function interact(
	nerve: InProcessNerve,
	type: string,
	args: Record<string, unknown>,
	result = "some-result",
	corr = "corr-1",
) {
	const toolCallId = `t-${Math.random()}`;
	nerve.asNerve().motor.publish({ type, payload: { toolCallId, ...args }, correlationId: corr });
	// Publish the matching sense result so the detector can complete the hash.
	nerve.asNerve().sense.publish({
		type,
		payload: { toolCallId, content: result },
		isError: false,
		correlationId: corr,
	});
}

/** Publish only the motor event (no sense result). */
function motorOnly(nerve: InProcessNerve, type: string, args: Record<string, unknown>, corr = "corr-1") {
	nerve.asNerve().motor.publish({ type, payload: { toolCallId: `t-${Math.random()}`, ...args }, correlationId: corr });
}

describe("LoopGuard", { tags: ["unit"] }, () => {
	it("exposes organ interface", () => {
		const organ = new LoopGuard();
		expect(organ.name).toBe("loop-detector");
		expect(organ.tools).toHaveLength(0);
		expect(organ.subscriptions.motor).toContain("*");
	});

	it("does not fire for many calls to the same tool with different args and results", () => {
		const onLoop = vi.fn();
		const organ = new LoopGuard({ repeatedInteractionThreshold: 3, onLoop });
		const nerve = new InProcessNerve();
		organ.mount(nerve.asNerve());

		// 10 fs.read calls — different paths, different results — not a loop
		for (let i = 0; i < 10; i++) {
			interact(nerve, "fs.read", { path: `file${i}.ts` }, `content of file${i}`);
		}

		expect(onLoop).not.toHaveBeenCalled();
	});

	it("does not fire when same args produce different results (file changed between reads)", () => {
		const onLoop = vi.fn();
		const organ = new LoopGuard({ repeatedInteractionThreshold: 2, onLoop });
		const nerve = new InProcessNerve();
		organ.mount(nerve.asNerve());

		// Same path, different content each time — not a loop
		interact(nerve, "fs.read", { path: "README.md" }, "version 1");
		interact(nerve, "fs.read", { path: "README.md" }, "version 2");
		interact(nerve, "fs.read", { path: "README.md" }, "version 3");

		expect(onLoop).not.toHaveBeenCalled();
	});

	it("fires when same tool produces the same result with the same args more than threshold times", () => {
		const onLoop = vi.fn();
		const organ = new LoopGuard({ repeatedInteractionThreshold: 2, onLoop });
		const nerve = new InProcessNerve();
		organ.mount(nerve.asNerve());

		// Same path AND same content — identical interaction
		interact(nerve, "fs.read", { path: "README.md" }, "same content");
		interact(nerve, "fs.read", { path: "README.md" }, "same content");
		interact(nerve, "fs.read", { path: "README.md" }, "same content");

		expect(onLoop).toHaveBeenCalledOnce();
		expect(onLoop.mock.calls[0][0]).toBe("fs.read");
		expect(onLoop.mock.calls[0][1]).toContain("identical output");
	});

	it("does not fire when same interaction appears exactly at threshold", () => {
		const onLoop = vi.fn();
		const organ = new LoopGuard({ repeatedInteractionThreshold: 3, onLoop });
		const nerve = new InProcessNerve();
		organ.mount(nerve.asNerve());

		for (let i = 0; i < 3; i++) {
			interact(nerve, "fs.read", { path: "README.md" }, "same");
		}

		expect(onLoop).not.toHaveBeenCalled();
	});

	it("fires safety net when total calls for one tool exceed totalCallThreshold regardless of results", () => {
		const onLoop = vi.fn();
		const organ = new LoopGuard({ totalCallThreshold: 5, onLoop });
		const nerve = new InProcessNerve();
		organ.mount(nerve.asNerve());

		// 6 calls with unique content each time — total safety net fires
		for (let i = 0; i < 6; i++) {
			interact(nerve, "fs.read", { path: `unique-${i}.ts` }, `content-${i}`);
		}

		expect(onLoop).toHaveBeenCalled();
		expect(onLoop.mock.calls[0][1]).toContain("limit:");
	});

	it("resets counts on new correlationId", () => {
		const onLoop = vi.fn();
		const organ = new LoopGuard({ repeatedInteractionThreshold: 2, onLoop });
		const nerve = new InProcessNerve();
		organ.mount(nerve.asNerve());

		for (let i = 0; i < 2; i++) {
			interact(nerve, "fs.read", { path: "README.md" }, "same", "corr-1");
		}

		// New correlation — counters reset, 2 more identical calls should not fire
		for (let i = 0; i < 2; i++) {
			interact(nerve, "fs.read", { path: "README.md" }, "same", "corr-2");
		}

		expect(onLoop).not.toHaveBeenCalled();
	});

	it("unmount stops observing", () => {
		const onLoop = vi.fn();
		const organ = new LoopGuard({ repeatedInteractionThreshold: 2, onLoop });
		const nerve = new InProcessNerve();
		const unmount = organ.mount(nerve.asNerve());
		unmount();

		for (let i = 0; i < 5; i++) {
			interact(nerve, "fs.read", { path: "README.md" }, "same");
		}

		expect(onLoop).not.toHaveBeenCalled();
	});

	it("toolCallId is stripped before hashing — same logical call detected despite different ids", () => {
		const onLoop = vi.fn();
		const organ = new LoopGuard({ repeatedInteractionThreshold: 2, onLoop });
		const nerve = new InProcessNerve();
		organ.mount(nerve.asNerve());

		// interact() generates a unique toolCallId per call but same path+result
		for (let i = 0; i < 3; i++) {
			interact(nerve, "fs.read", { path: "same-file.ts" }, "same-content");
		}

		expect(onLoop).toHaveBeenCalledOnce();
	});

	it("total safety net fires on motor event alone (before sense result)", () => {
		const onLoop = vi.fn();
		const organ = new LoopGuard({ totalCallThreshold: 3, onLoop });
		const nerve = new InProcessNerve();
		organ.mount(nerve.asNerve());

		// Safety net counts motor events — sense result not required
		for (let i = 0; i < 4; i++) {
			motorOnly(nerve, "fs.read", { path: `f${i}.ts` });
		}

		expect(onLoop).toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// hashResult — Anthropic array-format content (ALE-BUG fix)
// ---------------------------------------------------------------------------

describe("hashResult — Anthropic array-format content", { tags: ["unit"] }, () => {
	it("detects loop when content is Anthropic-format array", () => {
		const loops: string[] = [];
		const nerve = new InProcessNerve();
		const organ = new LoopGuard({
			repeatedInteractionThreshold: 3,
			onLoop: (type) => loops.push(type),
		});
		organ.mount(nerve.asNerve());

		// Publish the same tool call with array-format content 3 times.
		const arrayContent = [{ type: "text", text: "identical output from tool" }];
		for (let i = 0; i < 4; i++) {
			const toolCallId = `tc-arr-${i}`;
			nerve.asNerve().motor.publish({
				type: "fs.read",
				payload: { toolCallId, path: "file.ts" },
				correlationId: "corr-arr",
			});
			nerve.asNerve().sense.publish({
				type: "fs.read",
				payload: { toolCallId, content: arrayContent },
				isError: false,
				correlationId: "corr-arr",
			});
		}

		expect(loops).toContain("fs.read");
	});

	it("array content and string content with same text produce the same hash (stable)", () => {
		// Both formats must detect the loop — the text is identical.
		const loopsArr: string[] = [];
		const loopsStr: string[] = [];

		const nerveArr = new InProcessNerve();
		new LoopGuard({
			repeatedInteractionThreshold: 3,
			onLoop: (t) => loopsArr.push(t),
		}).mount(nerveArr.asNerve());

		const nerveStr = new InProcessNerve();
		new LoopGuard({
			repeatedInteractionThreshold: 3,
			onLoop: (t) => loopsStr.push(t),
		}).mount(nerveStr.asNerve());

		const text = "same output text";

		for (let i = 0; i < 4; i++) {
			const tcArr = `tc-fmt-arr-${i}`;
			nerveArr
				.asNerve()
				.motor.publish({ type: "shell.exec", payload: { toolCallId: tcArr, command: "ls" }, correlationId: "c" });
			nerveArr.asNerve().sense.publish({
				type: "shell.exec",
				payload: { toolCallId: tcArr, content: [{ type: "text", text }] },
				isError: false,
				correlationId: "c",
			});

			const tcStr = `tc-fmt-str-${i}`;
			nerveStr
				.asNerve()
				.motor.publish({ type: "shell.exec", payload: { toolCallId: tcStr, command: "ls" }, correlationId: "c" });
			nerveStr.asNerve().sense.publish({
				type: "shell.exec",
				payload: { toolCallId: tcStr, content: text },
				isError: false,
				correlationId: "c",
			});
		}

		expect(loopsArr).toContain("shell.exec");
		expect(loopsStr).toContain("shell.exec");
	});
});
