import { describe, expect, it } from "vitest";
import type { SenseEvent } from "../src/buses.js";
import { InProcessNerve } from "../src/buses.js";
import type { CorpusHandlerCtx } from "../src/framework.js";
import { defineCerebrumOrgan, defineCorpusOrgan, defineOrgan } from "../src/framework.js";

function makeNerve() {
	const nerve = new InProcessNerve();
	return { nerve, n: nerve.asNerve() };
}

function waitSense(nerve: InProcessNerve, type: string): Promise<SenseEvent> {
	return new Promise((resolve) => {
		const off = nerve.asNerve().sense.subscribe(type, (e) => {
			off();
			resolve(e);
		});
	});
}

function publishMotor(nerve: InProcessNerve, type: string, payload: Record<string, unknown>) {
	nerve.asNerve().motor.publish({ type, payload, correlationId: "corr-1", timestamp: Date.now() });
}

// ---------------------------------------------------------------------------
// defineCorpusOrgan
// ---------------------------------------------------------------------------

describe("defineCorpusOrgan", () => {
	it("sets name", () => {
		const organ = defineCorpusOrgan("test", {});
		expect(organ.name).toBe("test");
	});

	it("collects tools from actions that declare them", () => {
		const organ = defineCorpusOrgan("test", {
			"test.a": { tool: { name: "test.a", description: "A", inputSchema: {} }, handle: async () => ({}) },
			"test.b": { handle: async () => ({}) },
			"test.c": { tool: { name: "test.c", description: "C", inputSchema: {} }, handle: async () => ({}) },
		});
		expect(organ.tools.map((t) => t.name)).toEqual(["test.a", "test.c"]);
	});

	it("mount subscribes to Motor events", () => {
		const { nerve, n } = makeNerve();
		defineCorpusOrgan("test", {
			"test.x": { handle: async () => ({}) },
			"test.y": { handle: async () => ({}) },
		}).mount(n);
		expect(nerve.listenerCount("motor", "test.x")).toBe(1);
		expect(nerve.listenerCount("motor", "test.y")).toBe(1);
	});

	it("unmount cleans up all subscriptions", () => {
		const { nerve, n } = makeNerve();
		const unmount = defineCorpusOrgan("test", {
			"test.x": { handle: async () => ({}) },
			"test.y": { handle: async () => ({}) },
		}).mount(n);
		unmount();
		expect(nerve.listenerCount("motor", "test.x")).toBe(0);
		expect(nerve.listenerCount("motor", "test.y")).toBe(0);
	});

	it("handle success publishes Sense with result payload", async () => {
		const { nerve, n } = makeNerve();
		defineCorpusOrgan("test", {
			"test.echo": { handle: async (ctx) => ({ echoed: ctx.payload.value }) },
		}).mount(n);

		const p = waitSense(nerve, "test.echo");
		publishMotor(nerve, "test.echo", { value: "hello" });
		const result = await p;

		expect(result.isError).toBe(false);
		expect(result.payload.echoed).toBe("hello");
		expect(result.correlationId).toBe("corr-1");
	});

	it("handle throw publishes Sense with isError=true", async () => {
		const { nerve, n } = makeNerve();
		defineCorpusOrgan("test", {
			"test.fail": {
				handle: async () => {
					throw new Error("boom");
				},
			},
		}).mount(n);

		const p = waitSense(nerve, "test.fail");
		publishMotor(nerve, "test.fail", {});
		const result = await p;

		expect(result.isError).toBe(true);
		expect(result.errorMessage).toBe("boom");
	});

	it("toolCallId from Motor payload is mirrored to Sense payload", async () => {
		const { nerve, n } = makeNerve();
		defineCorpusOrgan("test", {
			"test.tool": { handle: async () => ({ ok: true }) },
		}).mount(n);

		const p = waitSense(nerve, "test.tool");
		nerve.asNerve().motor.publish({
			type: "test.tool",
			payload: { toolCallId: "tc-42" },
			correlationId: "corr-1",
			timestamp: Date.now(),
		});
		const result = await p;

		expect(result.payload.toolCallId).toBe("tc-42");
		expect(result.payload.ok).toBe(true);
	});

	it("toolCallId mirrored even on error", async () => {
		const { nerve, n } = makeNerve();
		defineCorpusOrgan("test", {
			"test.fail": {
				handle: async () => {
					throw new Error("bad");
				},
			},
		}).mount(n);

		const p = waitSense(nerve, "test.fail");
		nerve.asNerve().motor.publish({
			type: "test.fail",
			payload: { toolCallId: "tc-err" },
			correlationId: "corr-1",
			timestamp: Date.now(),
		});
		const result = await p;

		expect(result.isError).toBe(true);
		expect(result.payload.toolCallId).toBe("tc-err");
	});

	it("streaming action emits N partial Sense events then one final", async () => {
		const { nerve, n } = makeNerve();
		defineCorpusOrgan("test", {
			"test.stream": {
				stream: async function* () {
					yield { chunk: "a" };
					yield { chunk: "b" };
					yield { chunk: "c" };
				},
			},
		}).mount(n);

		const events: SenseEvent[] = [];
		const done = new Promise<void>((resolve) => {
			nerve.asNerve().sense.subscribe("test.stream", (e) => {
				events.push(e);
				if ((e.payload as { isFinal?: boolean }).isFinal) resolve();
			});
		});

		publishMotor(nerve, "test.stream", {});
		await done;

		expect(events).toHaveLength(3);
		expect(events[0].payload.chunk).toBe("a");
		expect(events[0].payload.isFinal).toBe(false);
		expect(events[1].payload.chunk).toBe("b");
		expect(events[1].payload.isFinal).toBe(false);
		expect(events[2].payload.chunk).toBe("c");
		expect(events[2].payload.isFinal).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// defineCerebrumOrgan
// ---------------------------------------------------------------------------

describe("defineCerebrumOrgan", () => {
	it("sets name and tools=[]", () => {
		const organ = defineCerebrumOrgan("test", {});
		expect(organ.name).toBe("test");
		expect(organ.tools).toHaveLength(0);
	});

	it("mount subscribes to Sense events", () => {
		const { nerve, n } = makeNerve();
		defineCerebrumOrgan("test", {
			"sense.a": { handle: async () => {} },
		}).mount(n);
		expect(nerve.listenerCount("sense", "sense.a")).toBe(1);
	});

	it("unmount cleans up", () => {
		const { nerve, n } = makeNerve();
		const unmount = defineCerebrumOrgan("test", {
			"sense.a": { handle: async () => {} },
		}).mount(n);
		unmount();
		expect(nerve.listenerCount("sense", "sense.a")).toBe(0);
	});

	it("handle receives correlationId, payload, motor, sense", async () => {
		const { nerve, n } = makeNerve();
		let capturedCtx: { correlationId: string; payload: Record<string, unknown> } | null = null;

		defineCerebrumOrgan("test", {
			"test.input": {
				handle: async (ctx) => {
					capturedCtx = { correlationId: ctx.correlationId, payload: ctx.payload };
				},
			},
		}).mount(n);

		nerve.publishSense({
			type: "test.input",
			payload: { text: "hello", sender: "human" },
			correlationId: "corr-x",
			timestamp: Date.now(),
			isError: false,
		});

		await new Promise((r) => setTimeout(r, 10));

		expect(capturedCtx).not.toBeNull();
		expect(capturedCtx!.correlationId).toBe("corr-x");
		expect(capturedCtx!.payload.text).toBe("hello");
	});

	it("handler can fan-out Motor events via ctx.motor.publish", async () => {
		const { nerve, n } = makeNerve();
		const motorEvents: string[] = [];
		nerve.onAnyMotor((e) => motorEvents.push(e.type));

		defineCerebrumOrgan("test", {
			"test.trigger": {
				handle: async (ctx) => {
					ctx.motor.publish({
						type: "tool.a",
						payload: {},
						correlationId: ctx.correlationId,
						timestamp: Date.now(),
					});
					ctx.motor.publish({
						type: "tool.b",
						payload: {},
						correlationId: ctx.correlationId,
						timestamp: Date.now(),
					});
				},
			},
		}).mount(n);

		nerve.publishSense({
			type: "test.trigger",
			payload: {},
			correlationId: "c1",
			timestamp: Date.now(),
			isError: false,
		});
		await new Promise((r) => setTimeout(r, 10));

		expect(motorEvents).toContain("tool.a");
		expect(motorEvents).toContain("tool.b");
	});
});

// ---------------------------------------------------------------------------
// defineOrgan — prefix dispatch + cache
// ---------------------------------------------------------------------------

describe("defineOrgan — motor/ prefix", () => {
	it("subscribes Motor bus for motor/ keys", () => {
		const { nerve, n } = makeNerve();
		defineOrgan("test", { "motor/test.cmd": { handle: async () => ({}) } }).mount(n);
		expect(nerve.listenerCount("motor", "test.cmd")).toBe(1);
	});
});

describe("defineOrgan — sense/ prefix", () => {
	it("subscribes Sense bus for sense/ keys", () => {
		const { nerve, n } = makeNerve();
		defineOrgan("test", { "sense/test.evt": { handle: async () => {} } }).mount(n);
		expect(nerve.listenerCount("sense", "test.evt")).toBe(1);
	});
});

describe("defineOrgan — mixed organ", () => {
	it("can subscribe both Motor and Sense in one organ", () => {
		const { nerve, n } = makeNerve();
		defineOrgan("bridge", {
			"motor/bridge.cmd": { handle: async () => ({}) },
			"sense/bridge.evt": { handle: async () => {} },
		}).mount(n);
		expect(nerve.listenerCount("motor", "bridge.cmd")).toBe(1);
		expect(nerve.listenerCount("sense", "bridge.evt")).toBe(1);
	});
});

describe("defineOrgan — wildcard motor/*", () => {
	it("subscribes all Motor events", async () => {
		const { nerve, n } = makeNerve();
		const seen: string[] = [];
		defineOrgan("observer", {
			"motor/*": {
				handle: async (ctx: CorpusHandlerCtx) => {
					seen.push(ctx.payload.op as string);
					return {};
				},
			},
		}).mount(n);

		nerve
			.asNerve()
			.motor.publish({ type: "fs.read", payload: { op: "read" }, correlationId: "c", timestamp: Date.now() });
		nerve
			.asNerve()
			.motor.publish({ type: "fs.edit", payload: { op: "edit" }, correlationId: "c", timestamp: Date.now() });
		await new Promise((r) => setTimeout(r, 10));

		expect(seen).toContain("read");
		expect(seen).toContain("edit");
	});
});

describe("defineOrgan — cache", () => {
	it("caches result on second call (same payload)", async () => {
		const { nerve, n } = makeNerve();
		let callCount = 0;
		defineCorpusOrgan("test", {
			"test.read": {
				handle: async () => {
					callCount++;
					return { data: "result" };
				},
				shouldCache: () => true,
			},
		}).mount(n);

		const p1 = waitSense(nerve, "test.read");
		publishMotor(nerve, "test.read", { path: "/foo" });
		await p1;

		const p2 = waitSense(nerve, "test.read");
		publishMotor(nerve, "test.read", { path: "/foo" });
		await p2;

		expect(callCount).toBe(1); // second call served from cache
	});

	it("different payloads are cached separately", async () => {
		const { nerve, n } = makeNerve();
		let callCount = 0;
		defineCorpusOrgan("test", {
			"test.read": {
				handle: async (ctx) => {
					callCount++;
					return { path: ctx.payload.path };
				},
				shouldCache: () => true,
			},
		}).mount(n);

		publishMotor(nerve, "test.read", { path: "/foo" });
		await waitSense(nerve, "test.read");
		publishMotor(nerve, "test.read", { path: "/bar" });
		await waitSense(nerve, "test.read");

		expect(callCount).toBe(2);
	});

	it("invalidates cache entries by event-type prefix", async () => {
		const { nerve, n } = makeNerve();
		let readCount = 0;
		defineCorpusOrgan("test", {
			"test.read": {
				handle: async () => {
					readCount++;
					return { data: "v1" };
				},
				shouldCache: () => true,
			},
			"test.write": {
				handle: async () => ({}),
				invalidates: () => ["test.read"],
			},
		}).mount(n);

		// First read — populates cache.
		publishMotor(nerve, "test.read", { path: "/foo" });
		await waitSense(nerve, "test.read");
		expect(readCount).toBe(1);

		// Write — invalidates test.read cache.
		publishMotor(nerve, "test.write", { path: "/foo" });
		await waitSense(nerve, "test.write");

		// Second read — cache was purged, handler called again.
		publishMotor(nerve, "test.read", { path: "/foo" });
		await waitSense(nerve, "test.read");
		expect(readCount).toBe(2);
	});

	it("streaming action is never cached", async () => {
		const { nerve, n } = makeNerve();
		let callCount = 0;
		defineCorpusOrgan("test", {
			"test.stream": {
				stream: async function* () {
					callCount++;
					yield { chunk: "x" };
				},
			},
		}).mount(n);

		const waitFinal = () =>
			new Promise<void>((resolve) => {
				const off = nerve.asNerve().sense.subscribe("test.stream", (e) => {
					if ((e.payload as { isFinal?: boolean }).isFinal) {
						off();
						resolve();
					}
				});
			});

		publishMotor(nerve, "test.stream", { path: "/foo" });
		await waitFinal();
		publishMotor(nerve, "test.stream", { path: "/foo" });
		await waitFinal();

		expect(callCount).toBe(2); // streaming: always called
	});

	it("unmount clears the cache", async () => {
		const { nerve, n } = makeNerve();
		let callCount = 0;
		const organ = defineCorpusOrgan("test", {
			"test.read": {
				handle: async () => {
					callCount++;
					return {};
				},
				shouldCache: () => true,
			},
		});
		const unmount = organ.mount(n);

		publishMotor(nerve, "test.read", { path: "/foo" });
		await waitSense(nerve, "test.read");
		unmount();

		// Remount — fresh cache.
		organ.mount(n);
		publishMotor(nerve, "test.read", { path: "/foo" });
		await waitSense(nerve, "test.read");

		expect(callCount).toBe(2);
	});
});
