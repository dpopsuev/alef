import type { Nerve, Organ, ToolDefinition } from "@dpopsuev/alef-spine";
import { afterEach, describe, expect, it } from "vitest";
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
					timestamp: Date.now(),
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
						timestamp: Date.now(),
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
