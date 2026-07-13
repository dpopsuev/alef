import { LoopGuard } from "@dpopsuev/alef-agent/loop-detector";
import { InProcessBus } from "@dpopsuev/alef-kernel/bus";
import { describe, expect, it, vi } from "vitest";

/** Publish a command event and its matching sense result (full interaction). */
function interact(
	bus: InProcessBus,
	type: string,
	args: Record<string, unknown>,
	result = "some-result",
	corr = "corr-1",
) {
	const toolCallId = `t-${Math.random()}`;
	bus.asBus().command.publish({ type, payload: { toolCallId, ...args }, correlationId: corr });
	// Publish the matching sense result so the detector can complete the hash.
	bus.asBus().event.publish({
		type,
		payload: { toolCallId, content: result },
		isError: false,
		correlationId: corr,
	});
}

/** Publish only the command event (no sense result). */
function motorOnly(bus: InProcessBus, type: string, args: Record<string, unknown>, corr = "corr-1") {
	bus.asBus().command.publish({ type, payload: { toolCallId: `t-${Math.random()}`, ...args }, correlationId: corr });
}

describe("LoopGuard", { tags: ["unit"] }, () => {
	it("exposes adapter interface", () => {
		const adapter = new LoopGuard();
		expect(adapter.name).toBe("loop-detector");
		expect(adapter.tools).toHaveLength(0);
		expect(adapter.subscriptions.command).toContain("*");
	});

	it("does not fire for many calls to the same tool with different args and results", () => {
		const onLoop = vi.fn();
		const adapter = new LoopGuard({ repeatedInteractionThreshold: 3, onLoop });
		const bus = new InProcessBus();
		adapter.mount(bus.asBus());

		// 10 fs.read calls — different paths, different results — not a loop
		for (let i = 0; i < 10; i++) {
			interact(bus, "fs.read", { path: `file${i}.ts` }, `content of file${i}`);
		}

		expect(onLoop).not.toHaveBeenCalled();
	});

	it("does not fire when same args produce different results (file changed between reads)", () => {
		const onLoop = vi.fn();
		const adapter = new LoopGuard({ repeatedInteractionThreshold: 2, onLoop });
		const bus = new InProcessBus();
		adapter.mount(bus.asBus());

		// Same path, different content each time — not a loop
		interact(bus, "fs.read", { path: "README.md" }, "version 1");
		interact(bus, "fs.read", { path: "README.md" }, "version 2");
		interact(bus, "fs.read", { path: "README.md" }, "version 3");

		expect(onLoop).not.toHaveBeenCalled();
	});

	it("fires when same tool produces the same result with the same args more than threshold times", () => {
		const onLoop = vi.fn();
		const adapter = new LoopGuard({ repeatedInteractionThreshold: 2, onLoop });
		const bus = new InProcessBus();
		adapter.mount(bus.asBus());

		// Same path AND same content — identical interaction
		interact(bus, "fs.read", { path: "README.md" }, "same content");
		interact(bus, "fs.read", { path: "README.md" }, "same content");
		interact(bus, "fs.read", { path: "README.md" }, "same content");

		expect(onLoop).toHaveBeenCalledOnce();
		expect(onLoop.mock.calls[0]![0]).toBe("fs.read");
		expect(onLoop.mock.calls[0]![1]).toContain("identical output");
	});

	it("does not fire when same interaction appears exactly at threshold", () => {
		const onLoop = vi.fn();
		const adapter = new LoopGuard({ repeatedInteractionThreshold: 3, onLoop });
		const bus = new InProcessBus();
		adapter.mount(bus.asBus());

		for (let i = 0; i < 3; i++) {
			interact(bus, "fs.read", { path: "README.md" }, "same");
		}

		expect(onLoop).not.toHaveBeenCalled();
	});

	it("fires safety net when total calls for one tool exceed totalCallThreshold regardless of results", () => {
		const onLoop = vi.fn();
		const adapter = new LoopGuard({ totalCallThreshold: 5, onLoop });
		const bus = new InProcessBus();
		adapter.mount(bus.asBus());

		// 6 calls with unique content each time — total safety net fires
		for (let i = 0; i < 6; i++) {
			interact(bus, "fs.read", { path: `unique-${i}.ts` }, `content-${i}`);
		}

		expect(onLoop).toHaveBeenCalled();
		expect(onLoop.mock.calls[0]![1]).toContain("limit:");
	});

	it("resets counts on new correlationId", () => {
		const onLoop = vi.fn();
		const adapter = new LoopGuard({ repeatedInteractionThreshold: 2, onLoop });
		const bus = new InProcessBus();
		adapter.mount(bus.asBus());

		for (let i = 0; i < 2; i++) {
			interact(bus, "fs.read", { path: "README.md" }, "same", "corr-1");
		}

		// New correlation — counters reset, 2 more identical calls should not fire
		for (let i = 0; i < 2; i++) {
			interact(bus, "fs.read", { path: "README.md" }, "same", "corr-2");
		}

		expect(onLoop).not.toHaveBeenCalled();
	});

	it("unmount stops observing", () => {
		const onLoop = vi.fn();
		const adapter = new LoopGuard({ repeatedInteractionThreshold: 2, onLoop });
		const bus = new InProcessBus();
		const unmount = adapter.mount(bus.asBus());
		unmount();

		for (let i = 0; i < 5; i++) {
			interact(bus, "fs.read", { path: "README.md" }, "same");
		}

		expect(onLoop).not.toHaveBeenCalled();
	});

	it("toolCallId is stripped before hashing — same logical call detected despite different ids", () => {
		const onLoop = vi.fn();
		const adapter = new LoopGuard({ repeatedInteractionThreshold: 2, onLoop });
		const bus = new InProcessBus();
		adapter.mount(bus.asBus());

		// interact() generates a unique toolCallId per call but same path+result
		for (let i = 0; i < 3; i++) {
			interact(bus, "fs.read", { path: "same-file.ts" }, "same-content");
		}

		expect(onLoop).toHaveBeenCalledOnce();
	});

	it("total safety net fires on motor event alone (before sense result)", () => {
		const onLoop = vi.fn();
		const adapter = new LoopGuard({ totalCallThreshold: 3, onLoop });
		const bus = new InProcessBus();
		adapter.mount(bus.asBus());

		// Safety net counts command events — sense result not required
		for (let i = 0; i < 4; i++) {
			motorOnly(bus, "fs.read", { path: `f${i}.ts` });
		}

		expect(onLoop).toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// hashResult — Anthropic array-format content
// ---------------------------------------------------------------------------

describe("hashResult — Anthropic array-format content", { tags: ["unit"] }, () => {
	it("detects loop when content is Anthropic-format array", () => {
		const loops: string[] = [];
		const bus = new InProcessBus();
		const adapter = new LoopGuard({
			repeatedInteractionThreshold: 3,
			onLoop: (type) => loops.push(type),
		});
		adapter.mount(bus.asBus());

		// Publish the same tool call with array-format content 3 times.
		const arrayContent = [{ type: "text", text: "identical output from tool" }];
		for (let i = 0; i < 4; i++) {
			const toolCallId = `tc-arr-${i}`;
			bus.asBus().command.publish({
				type: "fs.read",
				payload: { toolCallId, path: "file.ts" },
				correlationId: "corr-arr",
			});
			bus.asBus().event.publish({
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

		const busArr = new InProcessBus();
		new LoopGuard({
			repeatedInteractionThreshold: 3,
			onLoop: (t) => loopsArr.push(t),
		}).mount(busArr.asBus());

		const busStr = new InProcessBus();
		new LoopGuard({
			repeatedInteractionThreshold: 3,
			onLoop: (t) => loopsStr.push(t),
		}).mount(busStr.asBus());

		const text = "same output text";

		for (let i = 0; i < 4; i++) {
			const tcArr = `tc-fmt-arr-${i}`;
			busArr
				.asBus()
				.command.publish({ type: "shell.exec", payload: { toolCallId: tcArr, command: "ls" }, correlationId: "c" });
			busArr.asBus().event.publish({
				type: "shell.exec",
				payload: { toolCallId: tcArr, content: [{ type: "text", text }] },
				isError: false,
				correlationId: "c",
			});

			const tcStr = `tc-fmt-str-${i}`;
			busStr
				.asBus()
				.command.publish({ type: "shell.exec", payload: { toolCallId: tcStr, command: "ls" }, correlationId: "c" });
			busStr.asBus().event.publish({
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
