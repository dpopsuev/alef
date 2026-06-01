import type { Nerve, Organ, ToolDefinition } from "@dpopsuev/alef-spine";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { DialogOrgan } from "../../organ-dialog/src/organ.js";
import { Agent } from "../src/index.js";

// ---------------------------------------------------------------------------
// Minimal stub organs for unit testing Agent in isolation.
// ---------------------------------------------------------------------------

function makeNoopOrgan(): Organ {
	return {
		name: "noop",
		tools: [],
		subscriptions: { motor: [] as const, sense: [] as const },
		mount: (_nerve: Nerve) => () => {},
	};
}

function makeNamedOrgan(name: string): Organ {
	return { name, tools: [], subscriptions: { motor: [] as const, sense: [] as const }, mount: () => () => {} };
}

function makeToolOrgan(toolNames: string[]): Organ {
	return {
		name: "tool-organ",
		tools: toolNames.map(
			(n): ToolDefinition => ({
				name: n,
				description: `Tool ${n}`,
				inputSchema: z.object({}),
			}),
		),
		subscriptions: { motor: [] as const, sense: [] as const },
		mount: (_nerve: Nerve) => () => {},
	};
}

/** Echo organ: subscribes Sense/"dialog.message", publishes Motor/"dialog.message". */
function makeEchoOrgan(): Organ {
	return {
		name: "echo",
		tools: [],
		subscriptions: { motor: [] as const, sense: [] as const },
		mount: (nerve: Nerve) => {
			return nerve.sense.subscribe("dialog.message", (event) => {
				nerve.motor.publish({
					type: "dialog.message",
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

describe("Agent — load()", () => {
	it("accepts an Organ and returns this for chaining", () => {
		const agent = makeAgent();
		expect(agent.load(makeNoopOrgan())).toBe(agent);
	});

	it("collects tool definitions from loaded organs", async () => {
		const agent = makeAgent();
		agent.load(makeToolOrgan(["file_read", "file_grep"]));
		agent.load(makeToolOrgan(["bash"]));

		let capturedTools: readonly { name: string }[] = [];
		agent.load({
			name: "tool-spy",
			tools: [],
			subscriptions: { motor: [] as const, sense: [] as const },
			mount: (nerve: Nerve) => {
				return nerve.sense.subscribe("dialog.message", (e) => {
					capturedTools = (e.payload.tools as { name: string }[]) ?? [];
					nerve.motor.publish({
						type: "dialog.message",
						payload: { text: "ok" },
						correlationId: e.correlationId,
					});
				});
			},
		});

		const dialog2 = new DialogOrgan({ sink: () => {} });
		agent.load(dialog2);
		await dialog2.send("hi");
		expect(capturedTools.map((t) => t.name)).toContain("file_read");
		expect(capturedTools.map((t) => t.name)).toContain("file_grep");
		expect(capturedTools.map((t) => t.name)).toContain("bash");
	});

	it("throws if agent is disposed", () => {
		const agent = makeAgent();
		agent.dispose();
		expect(() => agent.load(makeNoopOrgan())).toThrow("disposed");
	});

	it("calls organ.mount() exactly once per load()", () => {
		const agent = makeAgent();
		let mountCalls = 0;
		agent.load({
			name: "counted",
			tools: [],
			subscriptions: { motor: [] as const, sense: [] as const },
			mount: (_n: Nerve) => {
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

describe("Agent — dialog.send()", () => {
	it("resolves with reply text from an echo organ", async () => {
		const agent = makeAgent();
		const dialog = new DialogOrgan({ sink: () => {} });
		agent.load(dialog).load(makeEchoOrgan());
		const reply = await dialog.send("hello");
		expect(reply).toBe("echo: hello");
	});

	it("correlates concurrent prompts independently", async () => {
		const agent = makeAgent();
		const dialog = new DialogOrgan({ sink: () => {} });
		agent.load(dialog).load(makeEchoOrgan());
		const [a, b, cv] = await Promise.all([dialog.send("one"), dialog.send("two"), dialog.send("three")]);
		expect([a, b, cv].sort()).toEqual(["echo: one", "echo: three", "echo: two"]);
	});

	it("rejects when no organ replies within timeout", async () => {
		const agent = makeAgent();
		const dialog = new DialogOrgan({ sink: () => {} });
		agent.load(dialog).load(makeNoopOrgan());
		await expect(dialog.send("ping", "human", 20)).rejects.toThrow("timed out");
	});

	it("rejects immediately if dialog is unmounted", async () => {
		const agent = makeAgent();
		const dialog = new DialogOrgan({ sink: () => {} });
		agent.load(dialog);
		agent.dispose();
		await expect(dialog.send("hi")).rejects.toThrow();
	});
});

// ---------------------------------------------------------------------------
// dispose()
// ---------------------------------------------------------------------------

describe("Agent — dispose()", () => {
	it("calls organ unmount on dispose", () => {
		const agent = makeAgent();
		let unmounted = false;
		agent.load({
			name: "tracked",
			tools: [],
			subscriptions: { motor: [] as const, sense: [] as const },
			mount: (_n: Nerve) => () => {
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

describe("Agent payload validation", () => {
	it("passes when motor publish matches declared schema", async () => {
		const agent = new Agent();
		const organ: Organ = {
			name: "v-organ",
			tools: [],
			subscriptions: { motor: [], sense: [] },
			publishSchemas: {
				motor: { "v.event": z.object({ count: z.number() }) },
			},
			mount(nerve) {
				nerve.motor.publish({ type: "v.event", payload: { count: 1 }, correlationId: "c1" });
				return () => {};
			},
		};
		expect(() => agent.load(organ)).not.toThrow();
	});

	it("throws when motor publish violates declared schema", () => {
		const agent = new Agent();
		const organ: Organ = {
			name: "bad-organ",
			tools: [],
			subscriptions: { motor: [], sense: [] },
			publishSchemas: {
				motor: { "strict.event": z.object({ required: z.string() }) },
			},
			mount(nerve) {
				// Missing the required field.
				nerve.motor.publish({ type: "strict.event", payload: { wrong: true }, correlationId: "c1" });
				return () => {};
			},
		};
		expect(() => agent.load(organ)).toThrow(/PayloadValidation.*bad-organ.*strict\.event.*required/);
	});

	it("throws when sense publish violates declared schema", () => {
		const agent = new Agent();
		const organ: Organ = {
			name: "bad-sense-organ",
			tools: [],
			subscriptions: { motor: [], sense: [] },
			publishSchemas: {
				sense: { "sense.event": z.object({ value: z.number() }) },
			},
			mount(nerve) {
				// Wrong type — string instead of number.
				nerve.sense.publish({
					type: "sense.event",
					payload: { value: "not-a-number" },
					correlationId: "c1",

					isError: false,
				});
				return () => {};
			},
		};
		expect(() => agent.load(organ)).toThrow(/PayloadValidation.*bad-sense-organ.*sense\.event.*value/);
	});

	it("skips validation for event types with no registered schema", () => {
		const agent = new Agent();
		const organ: Organ = {
			name: "partial-organ",
			tools: [],
			subscriptions: { motor: [], sense: [] },
			publishSchemas: {
				motor: { "only.this": z.object({ x: z.number() }) },
			},
			mount(nerve) {
				// Publishes an event type with no schema — passes through unchecked.
				nerve.motor.publish({
					type: "other.event",
					payload: { anything: true },
					correlationId: "c1",
				});
				return () => {};
			},
		};
		expect(() => agent.load(organ)).not.toThrow();
	});

	it("error message includes organ name, event type, and field path", () => {
		const agent = new Agent();
		const organ: Organ = {
			name: "named-organ",
			tools: [],
			subscriptions: { motor: [], sense: [] },
			publishSchemas: {
				motor: { "typed.event": z.object({ score: z.number() }) },
			},
			mount(nerve) {
				nerve.motor.publish({ type: "typed.event", payload: {}, correlationId: "c1" });
				return () => {};
			},
		};
		let error: Error | undefined;
		try {
			agent.load(organ);
		} catch (e) {
			error = e as Error;
		}
		expect(error?.message).toContain("named-organ");
		expect(error?.message).toContain("motor/typed.event");
		expect(error?.message).toContain("score");
	});
});

// ---------------------------------------------------------------------------
// unload() + reload()
// ---------------------------------------------------------------------------

describe("Agent — unload()", () => {
	it("returns false when organ name not found", () => {
		const agent = makeAgent();
		expect(agent.unload("nonexistent")).toBe(false);
	});

	it("returns true and removes the organ by name", () => {
		const agent = makeAgent();
		const organ = makeNamedOrgan("my-organ");
		agent.load(organ);
		expect(agent.organs.some((o) => o.name === "my-organ")).toBe(true);
		expect(agent.unload("my-organ")).toBe(true);
		expect(agent.organs.some((o) => o.name === "my-organ")).toBe(false);
	});

	it("calls the unmount function returned by mount()", () => {
		const agent = makeAgent();
		let unmounted = false;
		agent.load({
			name: "tracked",
			tools: [],
			subscriptions: { motor: [] as const, sense: [] as const },
			mount: (_n: Nerve) => () => {
				unmounted = true;
			},
		});
		agent.unload("tracked");
		expect(unmounted).toBe(true);
	});

	it("removes tools from the unloaded organ", () => {
		const agent = makeAgent();
		agent.load(makeToolOrgan(["tool-a", "tool-b"]));
		expect(agent.tools.some((t) => t.name === "tool-a")).toBe(true);
		agent.unload("tool-organ");
		expect(agent.tools.some((t) => t.name === "tool-a")).toBe(false);
	});

	it("leaves other organs and their tools intact", () => {
		const agent = makeAgent();
		agent.load(makeToolOrgan(["keep-this"]));
		const keep = makeNamedOrgan("keep");
		agent.load(keep);
		agent.load(makeNamedOrgan("remove"));
		agent.unload("remove");
		expect(agent.organs.some((o) => o.name === "keep")).toBe(true);
		expect(agent.tools.some((t) => t.name === "keep-this")).toBe(true);
	});
});

describe("Agent — reload()", () => {
	it("replaces an existing organ with a new instance", () => {
		const agent = makeAgent();
		let v1Unmounted = false;
		agent.load({
			name: "hot-organ",
			tools: [],
			subscriptions: { motor: [] as const, sense: [] as const },
			mount: (_n: Nerve) => () => {
				v1Unmounted = true;
			},
		});

		let v2Mounted = false;
		const v2: Organ = {
			name: "hot-organ",
			tools: [],
			subscriptions: { motor: [] as const, sense: [] as const },
			mount: (_n: Nerve) => {
				v2Mounted = true;
				return () => {};
			},
		};

		agent.reload(v2);

		expect(v1Unmounted).toBe(true);
		expect(v2Mounted).toBe(true);
		expect(agent.organs.filter((o) => o.name === "hot-organ")).toHaveLength(1);
	});

	it("loads a new organ when name was not previously loaded", () => {
		const agent = makeAgent();
		agent.reload(makeNamedOrgan("fresh"));
		expect(agent.organs.some((o) => o.name === "fresh")).toBe(true);
	});

	it("updates tools to reflect the new organ's tool list", () => {
		const agent = makeAgent();
		agent.load({
			name: "organ",
			tools: [{ name: "old-tool", description: "", inputSchema: z.object({}) }],
			subscriptions: { motor: [] as const, sense: [] as const },
			mount: () => () => {},
		});
		agent.reload({
			name: "organ",
			tools: [{ name: "new-tool", description: "", inputSchema: z.object({}) }],
			subscriptions: { motor: [] as const, sense: [] as const },
			mount: () => () => {},
		});
		expect(agent.tools.some((t) => t.name === "old-tool")).toBe(false);
		expect(agent.tools.some((t) => t.name === "new-tool")).toBe(true);
	});
});
