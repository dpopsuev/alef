import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { SenseEvent } from "../src/buses.js";
import { InProcessNerve } from "../src/buses.js";
import type { MotorHandlerCtx, SenseHandlerCtx } from "../src/framework.js";
import { defineOrgan } from "../src/framework.js";

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
	nerve.asNerve().motor.publish({ type, payload, correlationId: "corr-1" });
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

describe("defineOrgan (motor/ prefix)", { tags: ["unit"] }, () => {
	it("sets name", () => {
		const organ = defineOrgan("test", {});
		expect(organ.name).toBe("test");
	});

	it("collects tools from actions that declare them", () => {
		const organ = defineOrgan(
			"test",
			{
				motor: {
					"test.a": {
						tool: { name: "test.a", description: "A", inputSchema: z.object({}) },
						async *handle() {
							yield {};
						},
					},
					"test.b": {
						async *handle() {
							yield {};
						},
					},
					"test.c": {
						tool: { name: "test.c", description: "C", inputSchema: z.object({}) },
						async *handle() {
							yield {};
						},
					},
				},
			},
			{
				description: "Test organ with tools.",
				directives: ["Use test.a and test.c for testing. Provide all required parameters."],
			},
		);
		expect(organ.tools.map((t: { name: string }) => t.name)).toEqual(["test.a", "test.c"]);
	});

	it("mount subscribes to Motor events", () => {
		const { nerve, n } = makeNerve();
		defineOrgan("test", {
			motor: {
				"test.x": {
					async *handle() {
						yield {};
					},
				},
				"test.y": {
					async *handle() {
						yield {};
					},
				},
			},
		}).mount(n);
		expect(nerve.listenerCount("motor", "test.x")).toBe(1);
		expect(nerve.listenerCount("motor", "test.y")).toBe(1);
	});

	it("unmount cleans up all subscriptions", () => {
		const { nerve, n } = makeNerve();
		const unmount = defineOrgan("test", {
			motor: {
				"test.x": {
					async *handle() {
						yield {};
					},
				},
				"test.y": {
					async *handle() {
						yield {};
					},
				},
			},
		}).mount(n);
		unmount();
		expect(nerve.listenerCount("motor", "test.x")).toBe(0);
		expect(nerve.listenerCount("motor", "test.y")).toBe(0);
	});

	it("handle success publishes Sense with result payload", async () => {
		const { nerve, n } = makeNerve();
		defineOrgan("test", {
			motor: {
				"test.echo": {
					async *handle(ctx: MotorHandlerCtx) {
						yield { echoed: ctx.payload.value };
					},
				},
			},
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
		defineOrgan("test", {
			motor: {
				"test.fail": {
					async *handle() {
						yield (await Promise.reject(new Error("boom"))) as Record<string, unknown>;
					},
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
		defineOrgan("test", {
			motor: {
				"test.tool": {
					async *handle() {
						yield { ok: true };
					},
				},
			},
		}).mount(n);

		const p = waitSense(nerve, "test.tool");
		nerve.asNerve().motor.publish({
			type: "test.tool",
			payload: { toolCallId: "tc-42" },
			correlationId: "corr-1",
		});
		const result = await p;

		expect(result.payload.toolCallId).toBe("tc-42");
		expect(result.payload.ok).toBe(true);
	});

	it("toolCallId mirrored even on error", async () => {
		const { nerve, n } = makeNerve();
		defineOrgan("test", {
			motor: {
				"test.fail": {
					async *handle() {
						yield (await Promise.reject(new Error("bad"))) as Record<string, unknown>;
					},
				},
			},
		}).mount(n);

		const p = waitSense(nerve, "test.fail");
		nerve.asNerve().motor.publish({
			type: "test.fail",
			payload: { toolCallId: "tc-err" },
			correlationId: "corr-1",
		});
		const result = await p;

		expect(result.isError).toBe(true);
		expect(result.payload.toolCallId).toBe("tc-err");
	});

	it("streaming action emits N partial Sense events then one final", async () => {
		const { nerve, n } = makeNerve();
		defineOrgan("test", {
			motor: {
				"test.stream": {
					async *handle() {
						yield { chunk: "a" };
						yield { chunk: "b" };
						yield { chunk: "c" };
					},
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
// defineOrgan with sense handler
// ---------------------------------------------------------------------------

describe("defineOrgan (sense/ prefix)", { tags: ["unit"] }, () => {
	it("sets name and tools=[]", () => {
		const organ = defineOrgan("test", {});
		expect(organ.name).toBe("test");
		expect(organ.tools).toHaveLength(0);
	});

	it("mount subscribes to Sense events", () => {
		const { nerve, n } = makeNerve();
		defineOrgan("test", {
			sense: { "sense.a": { handle: async () => {} } },
		}).mount(n);
		expect(nerve.listenerCount("sense", "sense.a")).toBe(1);
	});

	it("unmount cleans up", () => {
		const { nerve, n } = makeNerve();
		const unmount = defineOrgan("test", {
			sense: { "sense.a": { handle: async () => {} } },
		}).mount(n);
		unmount();
		expect(nerve.listenerCount("sense", "sense.a")).toBe(0);
	});

	it("handle receives correlationId, payload, motor, sense", async () => {
		const { nerve, n } = makeNerve();
		let capturedCtx: { correlationId: string; payload: Record<string, unknown> } | null = null;

		defineOrgan("test", {
			sense: {
				"test.input": {
					handle: async (ctx: SenseHandlerCtx) => {
						capturedCtx = { correlationId: ctx.correlationId, payload: ctx.payload };
					},
				},
			},
		}).mount(n);

		nerve.publishSense({
			type: "test.input",
			payload: { text: "hello", sender: "human" },
			correlationId: "corr-x",
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

		defineOrgan("test", {
			sense: {
				"test.trigger": {
					handle: async (ctx: SenseHandlerCtx) => {
						ctx.motor.publish({
							type: "tool.a",
							payload: {},
							correlationId: ctx.correlationId,
						});
						ctx.motor.publish({
							type: "tool.b",
							payload: {},
							correlationId: ctx.correlationId,
						});
					},
				},
			},
		}).mount(n);

		nerve.publishSense({
			type: "test.trigger",
			payload: {},
			correlationId: "c1",
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

describe("defineOrgan — motor/ prefix", { tags: ["unit"] }, () => {
	it("subscribes Motor bus for motor/ keys", () => {
		const { nerve, n } = makeNerve();
		defineOrgan("test", {
			motor: {
				"test.cmd": {
					async *handle() {
						yield {};
					},
				},
			},
		}).mount(n);
		expect(nerve.listenerCount("motor", "test.cmd")).toBe(1);
	});
});

describe("defineOrgan — sense/ prefix", { tags: ["unit"] }, () => {
	it("subscribes Sense bus for sense/ keys", () => {
		const { nerve, n } = makeNerve();
		defineOrgan("test", { sense: { "test.evt": { handle: async () => {} } } }).mount(n);
		expect(nerve.listenerCount("sense", "test.evt")).toBe(1);
	});
});

describe("defineOrgan — mixed organ", { tags: ["unit"] }, () => {
	it("can subscribe both Motor and Sense in one organ", () => {
		const { nerve, n } = makeNerve();
		defineOrgan("bridge", {
			motor: {
				"bridge.cmd": {
					async *handle() {
						yield {};
					},
				},
			},
			sense: { "bridge.evt": { handle: async () => {} } },
		}).mount(n);
		expect(nerve.listenerCount("motor", "bridge.cmd")).toBe(1);
		expect(nerve.listenerCount("sense", "bridge.evt")).toBe(1);
	});
});

describe("defineOrgan — wildcard motor/*", { tags: ["unit"] }, () => {
	it("subscribes all Motor events", async () => {
		const { nerve, n } = makeNerve();
		const seen: string[] = [];
		defineOrgan("observer", {
			motor: {
				"*": {
					async *handle(ctx: MotorHandlerCtx) {
						seen.push(ctx.payload.op as string);
						yield {};
					},
				},
			},
		}).mount(n);

		nerve.asNerve().motor.publish({ type: "fs.read", payload: { op: "read" }, correlationId: "c" });
		nerve.asNerve().motor.publish({ type: "fs.edit", payload: { op: "edit" }, correlationId: "c" });
		await new Promise((r) => setTimeout(r, 10));

		expect(seen).toContain("read");
		expect(seen).toContain("edit");
	});
});

describe("defineOrgan — cache", { tags: ["unit"] }, () => {
	it("caches result on second call (same payload)", async () => {
		const { nerve, n } = makeNerve();
		let callCount = 0;
		defineOrgan("test", {
			motor: {
				"test.read": {
					async *handle() {
						callCount++;
						yield { data: "result" };
					},
					shouldCache: () => true,
				},
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
		defineOrgan("test", {
			motor: {
				"test.read": {
					async *handle(ctx: MotorHandlerCtx) {
						callCount++;
						yield { path: ctx.payload.path };
					},
					shouldCache: () => true,
				},
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
		defineOrgan("test", {
			motor: {
				"test.read": {
					async *handle() {
						readCount++;
						yield { data: "v1" };
					},
					shouldCache: () => true,
				},
				"test.write": {
					async *handle() {
						yield {};
					},
					invalidates: () => ["test.read"],
				},
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
		defineOrgan("test", {
			motor: {
				"test.stream": {
					async *handle() {
						callCount++;
						yield { chunk: "x" };
					},
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
		const organ = defineOrgan("test", {
			motor: {
				"test.read": {
					async *handle() {
						callCount++;
						yield {};
					},
					shouldCache: () => true,
				},
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

// ---------------------------------------------------------------------------
// inputSchemas validation
// ---------------------------------------------------------------------------

describe("defineOrgan — inputSchemas validation", { tags: ["unit"] }, () => {
	it("rejects malformed motor payload with error sense in test env", async () => {
		const { z } = await import("zod");
		const nerve = new InProcessNerve();
		const received: SenseEvent[] = [];
		nerve.subscribeSense("typed.op", (e) => void received.push(e));

		const organ = defineOrgan(
			"typed",
			{
				motor: {
					"typed.op": {
						async *handle(ctx: MotorHandlerCtx) {
							yield { ok: true, input: ctx.payload.value };
						},
					},
				},
			},
			{
				inputSchemas: { motor: { "typed.op": z.object({ value: z.string() }) } },
			},
		);
		organ.mount(nerve.asNerve());

		publishMotor(nerve, "typed.op", { value: 42 }); // wrong type
		await new Promise((r) => setTimeout(r, 20));

		expect(received.length).toBeGreaterThan(0);
		expect(received[0].isError).toBe(true);
		expect(received[0].errorMessage).toMatch(/InputValidation/);
	});

	it("passes valid payload through to handler", async () => {
		const { z } = await import("zod");
		const nerve = new InProcessNerve();
		const received: SenseEvent[] = [];
		nerve.subscribeSense("valid.op", (e) => void received.push(e));

		const organ = defineOrgan(
			"valid-organ",
			{
				motor: {
					"valid.op": {
						async *handle() {
							yield { result: "ok" };
						},
					},
				},
			},
			{
				inputSchemas: { motor: { "valid.op": z.object({ value: z.string() }) } },
			},
		);
		organ.mount(nerve.asNerve());

		publishMotor(nerve, "valid.op", { value: "hello" });
		await new Promise((r) => setTimeout(r, 20));

		expect(received.length).toBeGreaterThan(0);
		expect(received[0].isError).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// ready() hook
// ---------------------------------------------------------------------------

describe("defineOrgan — ready() hook", { tags: ["unit"] }, () => {
	it("ready() is exposed on the organ and awaitable", async () => {
		let initialized = false;
		const organ = defineOrgan(
			"async-init",
			{},
			{
				ready: async () => {
					initialized = true;
				},
			},
		);
		expect(typeof organ.ready).toBe("function");
		await organ.ready?.();
		expect(initialized).toBe(true);
	});

	it("organ without ready() has ready undefined", () => {
		const organ = defineOrgan("no-init", {}, {});
		expect(organ.ready).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// ALE-SPC-34 — context metadata enforcement
// ---------------------------------------------------------------------------

describe("defineOrgan — context metadata enforcement", { tags: ["unit"] }, () => {
	const minTool = {
		motor: {
			"my.tool": {
				tool: { name: "my.tool", description: "Does something.", inputSchema: z.object({}) },
				async *handle() {
					yield { result: "ok" };
				},
			},
		},
	};

	it("throws when tool-bearing organ has no description", () => {
		expect(() =>
			defineOrgan("bad", minTool, { directives: ["Use my.tool to do something meaningful here."] }),
		).toThrow(/description/);
	});

	it("throws when tool-bearing organ has no directives", () => {
		expect(() => defineOrgan("bad", minTool, { description: "Does something." })).toThrow(/directives/);
	});

	it("throws when a directive block is shorter than 20 chars", () => {
		expect(() =>
			defineOrgan("bad", minTool, {
				description: "Does something.",
				directives: ["Too short."],
			}),
		).toThrow(/shorter than 20/);
	});

	it("throws when total directive chars exceed 2000", () => {
		expect(() =>
			defineOrgan("bad", minTool, {
				description: "Does something.",
				directives: ["x".repeat(2001)],
			}),
		).toThrow(/max 2000/);
	});

	it("accepts a valid tool-bearing organ with description and directives", () => {
		expect(() =>
			defineOrgan("good", minTool, {
				description: "Does something useful.",
				directives: ["Use my.tool when you need to do something. Always provide required parameters."],
			}),
		).not.toThrow();
	});

	it("allows organs without tools to omit directives", () => {
		expect(() => defineOrgan("kernel", {}, { description: "Kernel component with no tools." })).not.toThrow();
	});
});
