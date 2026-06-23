import type { Adapter, ToolDefinition } from "@dpopsuev/alef-kernel/adapter";
import type { Bus, BusMessage } from "@dpopsuev/alef-kernel/bus";
import { AgentController } from "@dpopsuev/alef-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent, type BusObserver } from "../src/index.js";

class BusEventRecorder implements BusObserver {
	readonly command: BusMessage[] = [];
	readonly event: BusMessage[] = [];
	onCommand(e: BusMessage): void {
		this.command.push(e);
	}
	onEvent(e: BusMessage): void {
		this.event.push(e);
	}
}

// ---------------------------------------------------------------------------
// Minimal stub adapters for unit testing Agent in isolation.
// ---------------------------------------------------------------------------

function makeNoopAdapter(): Adapter {
	return {
		name: "noop",
		tools: [],
		subscriptions: { command: [] as const, event: [] as const, notification: [] as const },
		sources: [],
		mount: (_bus: Bus) => () => {},
	};
}

function makeNamedAdapter(name: string): Adapter {
	return {
		name,
		tools: [],
		subscriptions: { command: [] as const, event: [] as const, notification: [] as const },
		sources: [],
		mount: () => () => {},
	};
}

function makeToolAdapter(toolNames: string[]): Adapter {
	return {
		name: "tool-adapter",
		tools: toolNames.map(
			(n): ToolDefinition => ({
				name: n,
				description: `Tool ${n}`,
				inputSchema: z.object({}),
			}),
		),
		subscriptions: { command: [] as const, event: [] as const, notification: [] as const },
		sources: [],
		mount: (_bus: Bus) => () => {},
	};
}

/** Echo adapter: subscribes Event/"llm.input", publishes Command/"llm.response". */
function makeEchoAdapter(): Adapter {
	return {
		name: "echo",
		tools: [],
		subscriptions: { command: [] as const, event: [] as const, notification: [] as const },
		sources: [],
		mount: (bus: Bus) => {
			return bus.event.subscribe("llm.input", (event) => {
				bus.command.publish({
					type: "llm.response",
					payload: { text: `echo: ${event.payload.text}` },
					correlationId: event.correlationId,
				});
			});
		},
	};
}

// ---------------------------------------------------------------------------

const corpora: Agent[] = [];
afterEach(() => {
	for (const c of corpora.splice(0)) c.dispose();
});
function makeAgent(): Agent {
	const c = new Agent();
	corpora.push(c);
	return c;
}

// ---------------------------------------------------------------------------
// load()
// ---------------------------------------------------------------------------

describe("Agent — load()", { tags: ["unit"] }, () => {
	it("accepts an Adapter and returns this for chaining", () => {
		const agent = makeAgent();
		expect(agent.load(makeNoopAdapter())).toBe(agent);
	});

	it("collects tool definitions from loaded adapters", () => {
		const agent = makeAgent();
		agent.load(makeToolAdapter(["file_read", "file_grep"]));
		agent.load(makeToolAdapter(["bash"]));

		const toolNames = agent.tools.map((t) => t.name);
		expect(toolNames).toContain("file_read");
		expect(toolNames).toContain("file_grep");
		expect(toolNames).toContain("bash");
	});

	it("throws if agent is disposed", () => {
		const agent = makeAgent();
		agent.dispose();
		expect(() => agent.load(makeNoopAdapter())).toThrow("disposed");
	});

	it("load() leaves agent uncorrupted when mount() throws", () => {
		const agent = makeAgent();
		const goodAdapter = makeNamedAdapter("good");
		agent.load(goodAdapter);

		const badAdapter: Adapter = {
			name: "bad",
			tools: [],
			subscriptions: { command: [] as const, event: [] as const, notification: [] as const },
			sources: [],
			mount: () => {
				throw new Error("mount failed");
			},
		};
		expect(() => agent.load(badAdapter)).toThrow("mount failed");

		// Agent must not contain the failed adapter — unload should not affect goodAdapter.
		expect(agent.tools.map((t) => t.name)).not.toContain("bad");
		// Subsequent unload of the good adapter must not corrupt (would call wrong unmount if index is off).
		agent.unload("good");
		expect(agent.tools).toHaveLength(0);
	});

	it("calls adapter.mount() exactly once per load()", () => {
		const agent = makeAgent();
		let mountCalls = 0;
		agent.load({
			name: "counted",
			tools: [],
			subscriptions: { command: [] as const, event: [] as const, notification: [] as const },
			sources: [],
			mount: (_n: Bus) => {
				mountCalls++;
				return () => {};
			},
		});
		expect(mountCalls).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// prompt()
// ---------------------------------------------------------------------------

describe("Agent — controller.send()", { tags: ["unit"] }, () => {
	it("resolves with reply text from an echo adapter", async () => {
		const agent = makeAgent();
		const controller = new AgentController(agent, { onReply: () => {} });
		agent.load(makeEchoAdapter());
		const reply = await controller.send("hello");
		expect(reply).toBe("echo: hello");
	});

	it("correlates concurrent prompts independently", async () => {
		const agent = makeAgent();
		const controller = new AgentController(agent, { onReply: () => {} });
		agent.load(makeEchoAdapter());
		const [a, b, cv] = await Promise.all([controller.send("one"), controller.send("two"), controller.send("three")]);
		expect([a, b, cv].sort()).toEqual(["echo: one", "echo: three", "echo: two"]);
	});

	it("rejects when no adapter replies within timeout", async () => {
		const agent = makeAgent();
		const controller = new AgentController(agent, { onReply: () => {} });
		agent.load(makeNoopAdapter());
		await expect(controller.send("ping", "human", 20)).rejects.toThrow("timed out");
	});

	it("rejects immediately if dialog is unmounted", async () => {
		const agent = makeAgent();
		const controller = new AgentController(agent, { onReply: () => {} });
		agent.dispose();
		await expect(controller.send("hi")).rejects.toThrow();
	});
});

// ---------------------------------------------------------------------------
// dispose()
// ---------------------------------------------------------------------------

describe("Agent — dispose()", { tags: ["unit"] }, () => {
	it("calls adapter unmount on dispose", () => {
		const agent = makeAgent();
		let unmounted = false;
		agent.load({
			name: "tracked",
			tools: [],
			subscriptions: { command: [] as const, event: [] as const, notification: [] as const },
			sources: [],
			mount: (_n: Bus) => () => {
				unmounted = true;
			},
		});
		agent.dispose();
		expect(unmounted).toBe(true);
	});

	it("is idempotent", () => {
		const agent = makeAgent();
		expect(() => {
			agent.dispose();
			agent.dispose();
			agent.dispose();
		}).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Payload validation tests
// ---------------------------------------------------------------------------

describe("Agent payload validation", { tags: ["unit"] }, () => {
	it("passes when command publish matches declared schema", async () => {
		const agent = new Agent();
		const adapter: Adapter = {
			name: "v-adapter",
			tools: [],
			subscriptions: { command: [], event: [], notification: [] },
			sources: [],
			publishSchemas: {
				command: { "v.event": z.object({ count: z.number() }) },
			},
			mount(bus) {
				bus.command.publish({ type: "v.event", payload: { count: 1 }, correlationId: "c1" });
				return () => {};
			},
		};
		expect(() => agent.load(adapter)).not.toThrow();
	});

	it("command publish schema violation routes to event error, does not throw", () => {
		const agent = new Agent();
		const recorder = new BusEventRecorder();
		agent.observe(recorder);
		const adapter: Adapter = {
			name: "bad-adapter",
			tools: [],
			subscriptions: { command: [], event: [], notification: [] },
			sources: [],
			publishSchemas: {
				command: { "strict.event": z.object({ required: z.string() }) },
			},
			mount(bus) {
				bus.command.publish({ type: "strict.event", payload: { wrong: true }, correlationId: "c1" });
				return () => {};
			},
		};
		expect(() => agent.load(adapter)).not.toThrow();
		const errEvent = recorder.event.find(
			(e: BusMessage) => e.type === "strict.event" && (e as { isError?: boolean }).isError,
		);
		expect(errEvent, "validation failure must emit an event error event").toBeDefined();
		expect((errEvent as { errorMessage?: string }).errorMessage).toMatch(
			/PayloadValidation.*bad-adapter.*strict\.event.*required/,
		);
	});

	it("event publish schema violation is dropped and does not throw", () => {
		const agent = new Agent();
		const adapter: Adapter = {
			name: "bad-event-adapter",
			tools: [],
			subscriptions: { command: [], event: [], notification: [] },
			sources: [],
			publishSchemas: {
				event: { "event.event": z.object({ value: z.number() }) },
			},
			mount(bus) {
				bus.event.publish({
					type: "event.event",
					payload: { value: "not-a-number" },
					correlationId: "c1",
					isError: false,
				});
				return () => {};
			},
		};
		expect(() => agent.load(adapter)).not.toThrow();
	});

	it("skips validation for event types with no registered schema", () => {
		const agent = new Agent();
		const adapter: Adapter = {
			name: "partial-adapter",
			tools: [],
			subscriptions: { command: [], event: [], notification: [] },
			sources: [],
			publishSchemas: {
				command: { "only.this": z.object({ x: z.number() }) },
			},
			mount(bus) {
				// Publishes an event type with no schema — passes through unchecked.
				bus.command.publish({
					type: "other.event",
					payload: { anything: true },
					correlationId: "c1",
				});
				return () => {};
			},
		};
		expect(() => agent.load(adapter)).not.toThrow();
	});

	it("event error message includes adapter name, event type, and field path", () => {
		const agent = new Agent();
		const recorder = new BusEventRecorder();
		agent.observe(recorder);
		const adapter: Adapter = {
			name: "named-adapter",
			tools: [],
			subscriptions: { command: [], event: [], notification: [] },
			sources: [],
			publishSchemas: {
				command: { "typed.event": z.object({ score: z.number() }) },
			},
			mount(bus) {
				bus.command.publish({ type: "typed.event", payload: {}, correlationId: "c1" });
				return () => {};
			},
		};
		expect(() => agent.load(adapter)).not.toThrow();
		const errEvent = recorder.event.find((e: BusMessage) => e.type === "typed.event");
		const msg = (errEvent as { errorMessage?: string })?.errorMessage ?? "";
		expect(msg).toContain("named-adapter");
		expect(msg).toContain("command/typed.event");
		expect(msg).toContain("score");
	});
});

// ---------------------------------------------------------------------------
// unload() + reload()
// ---------------------------------------------------------------------------

describe("Agent — unload()", { tags: ["unit"] }, () => {
	it("returns false when adapter name not found", () => {
		const agent = makeAgent();
		expect(agent.unload("nonexistent")).toBe(false);
	});

	it("returns true and removes the adapter by name", () => {
		const agent = makeAgent();
		const adpt = makeNamedAdapter("my-adapter");
		agent.load(adpt);
		expect(agent.adapters.some((o) => o.name === "my-adapter")).toBe(true);
		expect(agent.unload("my-adapter")).toBe(true);
		expect(agent.adapters.some((o) => o.name === "my-adapter")).toBe(false);
	});

	it("calls the unmount function returned by mount()", () => {
		const agent = makeAgent();
		let unmounted = false;
		agent.load({
			name: "tracked",
			tools: [],
			subscriptions: { command: [] as const, event: [] as const, notification: [] as const },
			sources: [],
			mount: (_n: Bus) => () => {
				unmounted = true;
			},
		});
		agent.unload("tracked");
		expect(unmounted).toBe(true);
	});

	it("removes tools from the unloaded adapter", () => {
		const agent = makeAgent();
		agent.load(makeToolAdapter(["tool-a", "tool-b"]));
		expect(agent.tools.some((t) => t.name === "tool-a")).toBe(true);
		agent.unload("tool-adapter");
		expect(agent.tools.some((t) => t.name === "tool-a")).toBe(false);
	});

	it("leaves other adapters and their tools intact", () => {
		const agent = makeAgent();
		agent.load(makeToolAdapter(["keep-this"]));
		const keep = makeNamedAdapter("keep");
		agent.load(keep);
		agent.load(makeNamedAdapter("remove"));
		agent.unload("remove");
		expect(agent.adapters.some((o) => o.name === "keep")).toBe(true);
		expect(agent.tools.some((t) => t.name === "keep-this")).toBe(true);
	});
});

describe("Agent — reload()", { tags: ["unit"] }, () => {
	it("replaces an existing adapter with a new instance", () => {
		const agent = makeAgent();
		let v1Unmounted = false;
		agent.load({
			name: "hot-adapter",
			tools: [],
			subscriptions: { command: [] as const, event: [] as const, notification: [] as const },
			sources: [],
			mount: (_n: Bus) => () => {
				v1Unmounted = true;
			},
		});

		let v2Mounted = false;
		const v2: Adapter = {
			name: "hot-adapter",
			tools: [],
			subscriptions: { command: [] as const, event: [] as const, notification: [] as const },
			sources: [],
			mount: (_n: Bus) => {
				v2Mounted = true;
				return () => {};
			},
		};

		agent.reload(v2);

		expect(v1Unmounted).toBe(true);
		expect(v2Mounted).toBe(true);
		expect(agent.adapters.filter((o) => o.name === "hot-adapter")).toHaveLength(1);
	});

	it("loads a new adapter when name was not previously loaded", () => {
		const agent = makeAgent();
		agent.reload(makeNamedAdapter("fresh"));
		expect(agent.adapters.some((o) => o.name === "fresh")).toBe(true);
	});

	it("updates tools to reflect the new adapter's tool list", () => {
		const agent = makeAgent();
		agent.load({
			name: "adapter",
			tools: [{ name: "old-tool", description: "", inputSchema: z.object({}) }],
			subscriptions: { command: [] as const, event: [] as const, notification: [] as const },
			sources: [],
			mount: () => () => {},
		});
		agent.reload({
			name: "adapter",
			tools: [{ name: "new-tool", description: "", inputSchema: z.object({}) }],
			subscriptions: { command: [] as const, event: [] as const, notification: [] as const },
			sources: [],
			mount: () => () => {},
		});
		expect(agent.tools.some((t) => t.name === "old-tool")).toBe(false);
		expect(agent.tools.some((t) => t.name === "new-tool")).toBe(true);
	});
});
