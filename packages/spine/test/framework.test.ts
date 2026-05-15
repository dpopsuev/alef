import { describe, expect, it } from "vitest";
import type { SenseEvent } from "../src/buses.js";
import { InProcessNerve } from "../src/buses.js";
import { defineCerebrumOrgan, defineCorpusOrgan } from "../src/framework.js";

function makeNerve() {
	const nerve = new InProcessNerve();
	return { nerve, corpus: nerve.asCorpusNerve(), cerebrum: nerve.asCerebrumNerve() };
}

function waitSense(nerve: InProcessNerve, type: string): Promise<SenseEvent> {
	return new Promise((resolve) => {
		const off = nerve.asCerebrumNerve().sense.subscribe(type, (e) => {
			off();
			resolve(e);
		});
	});
}

function publishMotor(nerve: InProcessNerve, type: string, payload: Record<string, unknown>) {
	nerve.asCerebrumNerve().motor.publish({ type, payload, correlationId: "corr-1", timestamp: Date.now() });
}

// ---------------------------------------------------------------------------
// defineCorpusOrgan
// ---------------------------------------------------------------------------

describe("defineCorpusOrgan", () => {
	it("sets kind=corpus and name", () => {
		const organ = defineCorpusOrgan("test", {});
		expect(organ.kind).toBe("corpus");
		expect(organ.name).toBe("test");
	});

	it("collects tools from actions that declare them", () => {
		const organ = defineCorpusOrgan("test", {
			"test.a": { tool: { name: "test.a", description: "A", inputSchema: {} }, handle: async () => ({}) },
			"test.b": { handle: async () => ({}) }, // no tool
			"test.c": { tool: { name: "test.c", description: "C", inputSchema: {} }, handle: async () => ({}) },
		});
		expect(organ.tools.map((t) => t.name)).toEqual(["test.a", "test.c"]);
	});

	it("mount subscribes to all Motor event types", () => {
		const { nerve, corpus } = makeNerve();
		const organ = defineCorpusOrgan("test", {
			"test.x": { handle: async () => ({}) },
			"test.y": { handle: async () => ({}) },
		});
		organ.mount(corpus);
		expect(nerve.listenerCount("motor", "test.x")).toBe(1);
		expect(nerve.listenerCount("motor", "test.y")).toBe(1);
	});

	it("unmount cleans up all subscriptions", () => {
		const { nerve, corpus } = makeNerve();
		const organ = defineCorpusOrgan("test", {
			"test.x": { handle: async () => ({}) },
			"test.y": { handle: async () => ({}) },
		});
		const unmount = organ.mount(corpus);
		unmount();
		expect(nerve.listenerCount("motor", "test.x")).toBe(0);
		expect(nerve.listenerCount("motor", "test.y")).toBe(0);
	});

	it("handle success publishes Sense with result payload", async () => {
		const { nerve, corpus } = makeNerve();
		defineCorpusOrgan("test", {
			"test.echo": { handle: async (ctx) => ({ echoed: ctx.payload.value }) },
		}).mount(corpus);

		const p = waitSense(nerve, "test.echo");
		publishMotor(nerve, "test.echo", { value: "hello" });
		const result = await p;

		expect(result.isError).toBe(false);
		expect(result.payload.echoed).toBe("hello");
		expect(result.correlationId).toBe("corr-1");
	});

	it("handle throw publishes Sense with isError=true", async () => {
		const { nerve, corpus } = makeNerve();
		defineCorpusOrgan("test", {
			"test.fail": {
				handle: async () => {
					throw new Error("boom");
				},
			},
		}).mount(corpus);

		const p = waitSense(nerve, "test.fail");
		publishMotor(nerve, "test.fail", {});
		const result = await p;

		expect(result.isError).toBe(true);
		expect(result.errorMessage).toBe("boom");
	});

	it("toolCallId from Motor payload is mirrored to Sense payload", async () => {
		const { nerve, corpus } = makeNerve();
		defineCorpusOrgan("test", {
			"test.tool": { handle: async () => ({ ok: true }) },
		}).mount(corpus);

		const p = waitSense(nerve, "test.tool");
		nerve.asCerebrumNerve().motor.publish({
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
		const { nerve, corpus } = makeNerve();
		defineCorpusOrgan("test", {
			"test.fail": {
				handle: async () => {
					throw new Error("bad");
				},
			},
		}).mount(corpus);

		const p = waitSense(nerve, "test.fail");
		nerve.asCerebrumNerve().motor.publish({
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
		const { nerve, corpus } = makeNerve();
		defineCorpusOrgan("test", {
			"test.stream": {
				stream: async function* () {
					yield { chunk: "a" };
					yield { chunk: "b" };
					yield { chunk: "c" };
				},
			},
		}).mount(corpus);

		const events: SenseEvent[] = [];
		const done = new Promise<void>((resolve) => {
			nerve.asCerebrumNerve().sense.subscribe("test.stream", (e) => {
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
	it("sets kind=cerebrum, name, tools=[]", () => {
		const organ = defineCerebrumOrgan("test", {});
		expect(organ.kind).toBe("cerebrum");
		expect(organ.name).toBe("test");
		expect(organ.tools).toHaveLength(0);
	});

	it("mount subscribes to Sense events", () => {
		const { nerve, cerebrum } = makeNerve();
		const organ = defineCerebrumOrgan("test", {
			"sense.a": { handle: async () => {} },
		});
		organ.mount(cerebrum);
		expect(nerve.listenerCount("sense", "sense.a")).toBe(1);
	});

	it("unmount cleans up", () => {
		const { nerve, cerebrum } = makeNerve();
		const organ = defineCerebrumOrgan("test", {
			"sense.a": { handle: async () => {} },
		});
		const unmount = organ.mount(cerebrum);
		unmount();
		expect(nerve.listenerCount("sense", "sense.a")).toBe(0);
	});

	it("handle receives correlationId, payload, motor, sense", async () => {
		const { nerve, cerebrum } = makeNerve();
		let capturedCtx: { correlationId: string; payload: Record<string, unknown> } | null = null;

		defineCerebrumOrgan("test", {
			"test.input": {
				handle: async (ctx) => {
					capturedCtx = { correlationId: ctx.correlationId, payload: ctx.payload };
				},
			},
		}).mount(cerebrum);

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
		const { nerve, cerebrum } = makeNerve();
		const motorEvents: string[] = [];

		nerve.onAnyMotor((e) => {
			motorEvents.push(e.type);
		});

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
		}).mount(cerebrum);

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
