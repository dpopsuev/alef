import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { EventMessage } from "../src/bus/messages.js";
import type { CommandHandlerCtx, EventHandlerCtx } from "../src/adapter/framework.js";
import { defineAdapter } from "../src/adapter/framework.js";
import { InProcessBus } from "../src/bus/in-process-bus.js";

function makeBus() {
	const bus = new InProcessBus();
	return { bus, n: bus.asBus() };
}

function waitEvent(bus: InProcessBus, type: string): Promise<EventMessage> {
	return new Promise((resolve) => {
		const off = bus.asBus().event.subscribe(type, (e) => {
			off();
			resolve(e);
		});
	});
}

function publishCommand(bus: InProcessBus, type: string, payload: Record<string, unknown>) {
	bus.asBus().command.publish({ type, payload, correlationId: "corr-1" });
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

describe("defineAdapter (command/ prefix)", { tags: ["unit"] }, () => {
	it("sets name", () => {
		const adapter = defineAdapter("test", {});
		expect(adapter.name).toBe("test");
	});

	it("collects tools from actions that declare them", () => {
		const adapter = defineAdapter(
			"test",
			{
				command: {
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
				description: "Test adapter with tools.",
				directives: ["Use test.a and test.c for testing. Provide all required parameters."],
			},
		);
		expect(adapter.tools.map((t: { name: string }) => t.name)).toEqual(["test.a", "test.c"]);
	});

	it("mount subscribes to Command messages", () => {
		const { bus, n } = makeBus();
		defineAdapter("test", {
			command: {
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
		expect(bus.listenerCount("command", "test.x")).toBe(1);
		expect(bus.listenerCount("command", "test.y")).toBe(1);
	});

	it("unmount cleans up all subscriptions", () => {
		const { bus, n } = makeBus();
		const unmount = defineAdapter("test", {
			command: {
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
		expect(bus.listenerCount("command", "test.x")).toBe(0);
		expect(bus.listenerCount("command", "test.y")).toBe(0);
	});

	it("handle success publishes Event with result payload", async () => {
		const { bus, n } = makeBus();
		defineAdapter("test", {
			command: {
				"test.echo": {
					async *handle(ctx: CommandHandlerCtx) {
						yield { echoed: ctx.payload.value };
					},
				},
			},
		}).mount(n);

		const p = waitEvent(bus, "test.echo");
		publishCommand(bus, "test.echo", { value: "hello" });
		const result = await p;

		expect(result.isError).toBe(false);
		expect(result.payload.echoed).toBe("hello");
		expect(result.correlationId).toBe("corr-1");
	});

	it("handle throw publishes Event with isError=true", async () => {
		const { bus, n } = makeBus();
		defineAdapter("test", {
			command: {
				"test.fail": {
					async *handle() {
						yield (await Promise.reject(new Error("boom"))) as Record<string, unknown>;
					},
				},
			},
		}).mount(n);

		const p = waitEvent(bus, "test.fail");
		publishCommand(bus, "test.fail", {});
		const result = await p;

		expect(result.isError).toBe(true);
		expect(result.errorMessage).toBe("boom");
	});

	it("toolCallId from Command payload is mirrored to Event payload", async () => {
		const { bus, n } = makeBus();
		defineAdapter("test", {
			command: {
				"test.tool": {
					async *handle() {
						yield { ok: true };
					},
				},
			},
		}).mount(n);

		const p = waitEvent(bus, "test.tool");
		bus.asBus().command.publish({
			type: "test.tool",
			payload: { toolCallId: "tc-42" },
			correlationId: "corr-1",
		});
		const result = await p;

		expect(result.payload.toolCallId).toBe("tc-42");
		expect(result.payload.ok).toBe(true);
	});

	it("toolCallId mirrored even on error", async () => {
		const { bus, n } = makeBus();
		defineAdapter("test", {
			command: {
				"test.fail": {
					async *handle() {
						yield (await Promise.reject(new Error("bad"))) as Record<string, unknown>;
					},
				},
			},
		}).mount(n);

		const p = waitEvent(bus, "test.fail");
		bus.asBus().command.publish({
			type: "test.fail",
			payload: { toolCallId: "tc-err" },
			correlationId: "corr-1",
		});
		const result = await p;

		expect(result.isError).toBe(true);
		expect(result.payload.toolCallId).toBe("tc-err");
	});

	it("streaming action emits N partial Event messages then one final", async () => {
		const { bus, n } = makeBus();
		defineAdapter("test", {
			command: {
				"test.stream": {
					async *handle() {
						yield { chunk: "a" };
						yield { chunk: "b" };
						yield { chunk: "c" };
					},
				},
			},
		}).mount(n);

		const events: EventMessage[] = [];
		const done = new Promise<void>((resolve) => {
			bus.asBus().event.subscribe("test.stream", (e) => {
				events.push(e);
				if ((e.payload as { isFinal?: boolean }).isFinal) resolve();
			});
		});

		publishCommand(bus, "test.stream", {});
		await done;

		expect(events).toHaveLength(3);
		expect(events[0]!.payload.chunk).toBe("a");
		expect(events[0]!.payload.isFinal).toBe(false);
		expect(events[1]!.payload.chunk).toBe("b");
		expect(events[1]!.payload.isFinal).toBe(false);
		expect(events[2]!.payload.chunk).toBe("c");
		expect(events[2]!.payload.isFinal).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// defineAdapter with event handler
// ---------------------------------------------------------------------------

describe("defineAdapter (event/ prefix)", { tags: ["unit"] }, () => {
	it("sets name and tools=[]", () => {
		const adapter = defineAdapter("test", {});
		expect(adapter.name).toBe("test");
		expect(adapter.tools).toHaveLength(0);
	});

	it("mount subscribes to Event messages", () => {
		const { bus, n } = makeBus();
		defineAdapter("test", {
			event: { "sense.a": { handle: async () => {} } },
		}).mount(n);
		expect(bus.listenerCount("event", "sense.a")).toBe(1);
	});

	it("unmount cleans up", () => {
		const { bus, n } = makeBus();
		const unmount = defineAdapter("test", {
			event: { "sense.a": { handle: async () => {} } },
		}).mount(n);
		unmount();
		expect(bus.listenerCount("event", "sense.a")).toBe(0);
	});

	it("handle receives correlationId, payload, command, event", async () => {
		const { bus, n } = makeBus();
		let capturedCtx: { correlationId: string; payload: Record<string, unknown> } | null = null;

		defineAdapter("test", {
			event: {
				"test.input": {
					handle: async (ctx: EventHandlerCtx) => {
						capturedCtx = { correlationId: ctx.correlationId, payload: ctx.payload };
					},
				},
			},
		}).mount(n);

		bus.publish("event", {
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

	it("handler can fan-out Command messages via ctx.command.publish", async () => {
		const { bus, n } = makeBus();
		const commandMessages: string[] = [];
		bus.onAny("command", (e) => commandMessages.push(e.type));

		defineAdapter("test", {
			event: {
				"test.trigger": {
					handle: async (ctx: EventHandlerCtx) => {
						ctx.bus.command.publish({
							type: "tool.a",
							payload: {},
							correlationId: ctx.correlationId,
						});
						ctx.bus.command.publish({
							type: "tool.b",
							payload: {},
							correlationId: ctx.correlationId,
						});
					},
				},
			},
		}).mount(n);

		bus.publish("event", {
			type: "test.trigger",
			payload: {},
			correlationId: "c1",
			isError: false,
		});
		await new Promise((r) => setTimeout(r, 10));

		expect(commandMessages).toContain("tool.a");
		expect(commandMessages).toContain("tool.b");
	});
});

// ---------------------------------------------------------------------------
// defineAdapter — prefix dispatch + cache
// ---------------------------------------------------------------------------

describe("defineAdapter — command/ prefix", { tags: ["unit"] }, () => {
	it("subscribes Command bus for command/ keys", () => {
		const { bus, n } = makeBus();
		defineAdapter("test", {
			command: {
				"test.cmd": {
					async *handle() {
						yield {};
					},
				},
			},
		}).mount(n);
		expect(bus.listenerCount("command", "test.cmd")).toBe(1);
	});
});

describe("defineAdapter — event/ prefix", { tags: ["unit"] }, () => {
	it("subscribes Event bus for event/ keys", () => {
		const { bus, n } = makeBus();
		defineAdapter("test", { event: { "test.evt": { handle: async () => {} } } }).mount(n);
		expect(bus.listenerCount("event", "test.evt")).toBe(1);
	});
});

describe("defineAdapter — mixed adapter", { tags: ["unit"] }, () => {
	it("can subscribe both Command and Event in one adapter", () => {
		const { bus, n } = makeBus();
		defineAdapter("bridge", {
			command: {
				"bridge.cmd": {
					async *handle() {
						yield {};
					},
				},
			},
			event: { "bridge.evt": { handle: async () => {} } },
		}).mount(n);
		expect(bus.listenerCount("command", "bridge.cmd")).toBe(1);
		expect(bus.listenerCount("event", "bridge.evt")).toBe(1);
	});
});

describe("defineAdapter — wildcard command/*", { tags: ["unit"] }, () => {
	it("subscribes all Command messages", async () => {
		const { bus, n } = makeBus();
		const seen: string[] = [];
		defineAdapter("observer", {
			command: {
				"*": {
					async *handle(ctx: CommandHandlerCtx) {
						seen.push(ctx.payload.op as string);
						yield {};
					},
				},
			},
		}).mount(n);

		bus.asBus().command.publish({ type: "fs.read", payload: { op: "read" }, correlationId: "c" });
		bus.asBus().command.publish({ type: "fs.edit", payload: { op: "edit" }, correlationId: "c" });
		await new Promise((r) => setTimeout(r, 10));

		expect(seen).toContain("read");
		expect(seen).toContain("edit");
	});
});

describe("defineAdapter — cache", { tags: ["unit"] }, () => {
	it("caches result on second call (same payload)", async () => {
		const { bus, n } = makeBus();
		let callCount = 0;
		defineAdapter("test", {
			command: {
				"test.read": {
					async *handle() {
						callCount++;
						yield { data: "result" };
					},
					shouldCache: () => true,
				},
			},
		}).mount(n);

		const p1 = waitEvent(bus, "test.read");
		publishCommand(bus, "test.read", { path: "/foo" });
		await p1;

		const p2 = waitEvent(bus, "test.read");
		publishCommand(bus, "test.read", { path: "/foo" });
		await p2;

		expect(callCount).toBe(1); // second call served from cache
	});

	it("different payloads are cached separately", async () => {
		const { bus, n } = makeBus();
		let callCount = 0;
		defineAdapter("test", {
			command: {
				"test.read": {
					async *handle(ctx: CommandHandlerCtx) {
						callCount++;
						yield { path: ctx.payload.path };
					},
					shouldCache: () => true,
				},
			},
		}).mount(n);

		publishCommand(bus, "test.read", { path: "/foo" });
		await waitEvent(bus, "test.read");
		publishCommand(bus, "test.read", { path: "/bar" });
		await waitEvent(bus, "test.read");

		expect(callCount).toBe(2);
	});

	it("invalidates cache entries by event-type prefix", async () => {
		const { bus, n } = makeBus();
		let readCount = 0;
		defineAdapter("test", {
			command: {
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
		publishCommand(bus, "test.read", { path: "/foo" });
		await waitEvent(bus, "test.read");
		expect(readCount).toBe(1);

		// Write — invalidates test.read cache.
		publishCommand(bus, "test.write", { path: "/foo" });
		await waitEvent(bus, "test.write");

		// Second read — cache was purged, handler called again.
		publishCommand(bus, "test.read", { path: "/foo" });
		await waitEvent(bus, "test.read");
		expect(readCount).toBe(2);
	});

	it("streaming action is never cached", async () => {
		const { bus, n } = makeBus();
		let callCount = 0;
		defineAdapter("test", {
			command: {
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
				const off = bus.asBus().event.subscribe("test.stream", (e) => {
					if ((e.payload as { isFinal?: boolean }).isFinal) {
						off();
						resolve();
					}
				});
			});

		publishCommand(bus, "test.stream", { path: "/foo" });
		await waitFinal();
		publishCommand(bus, "test.stream", { path: "/foo" });
		await waitFinal();

		expect(callCount).toBe(2); // streaming: always called
	});

	it("unmount clears the cache", async () => {
		const { bus, n } = makeBus();
		let callCount = 0;
		const adapter = defineAdapter("test", {
			command: {
				"test.read": {
					async *handle() {
						callCount++;
						yield {};
					},
					shouldCache: () => true,
				},
			},
		});
		const unmount = adapter.mount(n);

		publishCommand(bus, "test.read", { path: "/foo" });
		await waitEvent(bus, "test.read");
		unmount();

		// Remount — fresh cache.
		adapter.mount(n);
		publishCommand(bus, "test.read", { path: "/foo" });
		await waitEvent(bus, "test.read");

		expect(callCount).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// inputSchemas validation
// ---------------------------------------------------------------------------

describe("defineAdapter — inputSchemas validation", { tags: ["unit"] }, () => {
	it("rejects malformed command payload with error event in test env", async () => {
		const { z } = await import("zod");
		const bus = new InProcessBus();
		const received: EventMessage[] = [];
		bus.subscribe("event", "typed.op", (e) => void received.push(e));

		const adapter = defineAdapter(
			"typed",
			{
				command: {
					"typed.op": {
						async *handle(ctx: CommandHandlerCtx) {
							yield { ok: true, input: ctx.payload.value };
						},
					},
				},
			},
			{
				inputSchemas: { command: { "typed.op": z.object({ value: z.string() }) } },
			},
		);
		adapter.mount(bus.asBus());

		publishCommand(bus, "typed.op", { value: 42 }); // wrong type
		await new Promise((r) => setTimeout(r, 20));

		expect(received.length).toBeGreaterThan(0);
		expect(received[0]!.isError).toBe(true);
		expect(received[0]!.errorMessage).toMatch(/argument validation failed/);
	});

	it("passes valid payload through to handler", async () => {
		const { z } = await import("zod");
		const bus = new InProcessBus();
		const received: EventMessage[] = [];
		bus.subscribe("event", "valid.op", (e) => void received.push(e));

		const adapter = defineAdapter(
			"valid-adapter",
			{
				command: {
					"valid.op": {
						async *handle() {
							yield { result: "ok" };
						},
					},
				},
			},
			{
				inputSchemas: { command: { "valid.op": z.object({ value: z.string() }) } },
			},
		);
		adapter.mount(bus.asBus());

		publishCommand(bus, "valid.op", { value: "hello" });
		await new Promise((r) => setTimeout(r, 20));

		expect(received.length).toBeGreaterThan(0);
		expect(received[0]!.isError).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// ready() hook
// ---------------------------------------------------------------------------

describe("defineAdapter — ready() hook", { tags: ["unit"] }, () => {
	it("ready() is exposed on the adapter and awaitable", async () => {
		let initialized = false;
		const adapter = defineAdapter(
			"async-init",
			{},
			{
				ready: async () => {
					initialized = true;
				},
			},
		);
		expect(typeof adapter.ready).toBe("function");
		await adapter.ready?.();
		expect(initialized).toBe(true);
	});

	it("adapter without ready() has ready undefined", () => {
		const adapter = defineAdapter("no-init", {}, {});
		expect(adapter.ready).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// context metadata enforcement
// ---------------------------------------------------------------------------

describe("defineAdapter — context metadata enforcement", { tags: ["unit"] }, () => {
	const minTool = {
		command: {
			"my.tool": {
				tool: { name: "my.tool", description: "Does something.", inputSchema: z.object({}) },
				async *handle() {
					yield { result: "ok" };
				},
			},
		},
	};

	it("throws when tool-bearing adapter has no description", () => {
		expect(() =>
			defineAdapter("bad", minTool, { directives: ["Use my.tool to do something meaningful here."] }),
		).toThrow(/description/);
	});

	it("throws when tool-bearing adapter has no directives", () => {
		expect(() => defineAdapter("bad", minTool, { description: "Does something." })).toThrow(/directives/);
	});

	it("accepts a valid tool-bearing adapter with description and directives", () => {
		expect(() =>
			defineAdapter("good", minTool, {
				description: "Does something useful.",
				directives: ["Use my.tool when you need to do something. Always provide required parameters."],
			}),
		).not.toThrow();
	});

	it("allows adapters without tools to omit directives", () => {
		expect(() => defineAdapter("kernel", {}, { description: "Kernel component with no tools." })).not.toThrow();
	});
});
