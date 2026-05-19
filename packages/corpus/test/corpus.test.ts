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

function makeToolOrgan(toolNames: string[]): Organ {
	return {
		name: "tool-organ",
		tools: toolNames.map(
			(n): ToolDefinition => ({
				name: n,
				description: `Tool ${n}`,
				inputSchema: { type: "object" as const },
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

		const dialog2 = new DialogOrgan({ sink: () => {}, getTools: () => agent.tools });
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
		const dialog = new DialogOrgan({ sink: () => {}, getTools: () => agent.tools });
		agent.load(dialog).load(makeEchoOrgan());
		const reply = await dialog.send("hello");
		expect(reply).toBe("echo: hello");
	});

	it("correlates concurrent prompts independently", async () => {
		const agent = makeAgent();
		const dialog = new DialogOrgan({ sink: () => {}, getTools: () => agent.tools });
		agent.load(dialog).load(makeEchoOrgan());
		const [a, b, cv] = await Promise.all([dialog.send("one"), dialog.send("two"), dialog.send("three")]);
		expect([a, b, cv].sort()).toEqual(["echo: one", "echo: three", "echo: two"]);
	});

	it("rejects when no organ replies within timeout", async () => {
		const agent = makeAgent();
		const dialog = new DialogOrgan({ sink: () => {}, getTools: () => agent.tools });
		agent.load(dialog).load(makeNoopOrgan());
		await expect(dialog.send("ping", "human", 20)).rejects.toThrow("timed out");
	});

	it("rejects immediately if dialog is unmounted", async () => {
		const agent = makeAgent();
		const dialog = new DialogOrgan({ sink: () => {}, getTools: () => agent.tools });
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
