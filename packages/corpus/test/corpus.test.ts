import type { Nerve, Organ, ToolDefinition } from "@dpopsuev/alef-spine";
import { afterEach, describe, expect, it } from "vitest";
import { DialogOrgan } from "../../organ-dialog/src/organ.js";
import { Corpus } from "../src/index.js";

// ---------------------------------------------------------------------------
// Minimal stub organs for unit testing Corpus in isolation.
// ---------------------------------------------------------------------------

function makeNoopOrgan(): Organ {
	return { name: "noop", tools: [], mount: (_nerve: Nerve) => () => {} };
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
		mount: (_nerve: Nerve) => () => {},
	};
}

/** Echo organ: subscribes Sense/"dialog.message", publishes Motor/"dialog.message". */
function makeEchoOrgan(): Organ {
	return {
		name: "echo",
		tools: [],
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

const corpora: Corpus[] = [];
afterEach(() => {
	for (const c of corpora.splice(0)) c.dispose();
});
function makeCorpus(): Corpus {
	const c = new Corpus();
	corpora.push(c);
	return c;
}

// ---------------------------------------------------------------------------
// load()
// ---------------------------------------------------------------------------

describe("Corpus — load()", () => {
	it("accepts an Organ and returns this for chaining", () => {
		const corpus = makeCorpus();
		expect(corpus.load(makeNoopOrgan())).toBe(corpus);
	});

	it("collects tool definitions from loaded organs", async () => {
		const corpus = makeCorpus();
		corpus.load(makeToolOrgan(["file_read", "file_grep"]));
		corpus.load(makeToolOrgan(["bash"]));

		let capturedTools: readonly { name: string }[] = [];
		corpus.load({
			name: "tool-spy",
			tools: [],
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

		const dialog2 = new DialogOrgan({ sink: () => {}, getTools: () => corpus.tools });
		corpus.load(dialog2);
		await dialog2.send("hi");
		expect(capturedTools.map((t) => t.name)).toContain("file_read");
		expect(capturedTools.map((t) => t.name)).toContain("file_grep");
		expect(capturedTools.map((t) => t.name)).toContain("bash");
	});

	it("throws if corpus is disposed", () => {
		const corpus = makeCorpus();
		corpus.dispose();
		expect(() => corpus.load(makeNoopOrgan())).toThrow("disposed");
	});

	it("calls organ.mount() exactly once per load()", () => {
		const corpus = makeCorpus();
		let mountCalls = 0;
		corpus.load({
			name: "counted",
			tools: [],
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

describe("Corpus — dialog.send()", () => {
	it("resolves with reply text from an echo organ", async () => {
		const corpus = makeCorpus();
		const dialog = new DialogOrgan({ sink: () => {}, getTools: () => corpus.tools });
		corpus.load(dialog).load(makeEchoOrgan());
		const reply = await dialog.send("hello");
		expect(reply).toBe("echo: hello");
	});

	it("correlates concurrent prompts independently", async () => {
		const corpus = makeCorpus();
		const dialog = new DialogOrgan({ sink: () => {}, getTools: () => corpus.tools });
		corpus.load(dialog).load(makeEchoOrgan());
		const [a, b, cv] = await Promise.all([dialog.send("one"), dialog.send("two"), dialog.send("three")]);
		expect([a, b, cv].sort()).toEqual(["echo: one", "echo: three", "echo: two"]);
	});

	it("rejects when no organ replies within timeout", async () => {
		const corpus = makeCorpus();
		const dialog = new DialogOrgan({ sink: () => {}, getTools: () => corpus.tools });
		corpus.load(dialog).load(makeNoopOrgan());
		await expect(dialog.send("ping", "human", 20)).rejects.toThrow("timed out");
	});

	it("rejects immediately if dialog is unmounted", async () => {
		const corpus = makeCorpus();
		const dialog = new DialogOrgan({ sink: () => {}, getTools: () => corpus.tools });
		corpus.load(dialog);
		corpus.dispose();
		await expect(dialog.send("hi")).rejects.toThrow();
	});
});

// ---------------------------------------------------------------------------
// dispose()
// ---------------------------------------------------------------------------

describe("Corpus — dispose()", () => {
	it("calls organ unmount on dispose", () => {
		const corpus = makeCorpus();
		let unmounted = false;
		corpus.load({
			name: "tracked",
			tools: [],
			mount: (_n: Nerve) => () => {
				unmounted = true;
			},
		});
		corpus.dispose();
		expect(unmounted).toBe(true);
	});

	it("is idempotent", () => {
		const corpus = makeCorpus();
		expect(() => {
			corpus.dispose();
			corpus.dispose();
			corpus.dispose();
		}).not.toThrow();
	});
});
