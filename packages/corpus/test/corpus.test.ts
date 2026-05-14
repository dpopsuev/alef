import type { CerebrumNerve, CerebrumOrgan, CorpusNerve, CorpusOrgan, ToolDefinition } from "@dpopsuev/alef-spine";
import { afterEach, describe, expect, it } from "vitest";
import { Corpus, CorpusTimeoutError } from "../src/index.js";

// ---------------------------------------------------------------------------
// Minimal stub organs for unit testing Corpus in isolation.
// ---------------------------------------------------------------------------

function makeNoopOrgan(): CerebrumOrgan {
	return { kind: "cerebrum", name: "noop", tools: [], mount: (_nerve: CerebrumNerve) => () => {} };
}

function makeToolOrgan(toolNames: string[]): CerebrumOrgan {
	return {
		kind: "cerebrum",
		name: "tool-organ",
		tools: toolNames.map(
			(n): ToolDefinition => ({
				name: n,
				description: `Tool ${n}`,
				inputSchema: { type: "object" as const },
			}),
		),
		mount: (_nerve: CerebrumNerve) => () => {},
	};
}

/** Echo organ — CorpusOrgan that subscribes Motor/"text.input", replies via Sense/"text.reply". */
function makeEchoOrgan(): CorpusOrgan {
	return {
		kind: "corpus",
		name: "echo",
		tools: [],
		mount: (nerve: CorpusNerve) => {
			return nerve.motor.subscribe("text.input", (event) => {
				nerve.sense.publish({
					type: "text.reply",
					payload: { text: `echo: ${event.payload.text}` },
					correlationId: event.correlationId,
					timestamp: Date.now(),
					isError: false,
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
function makeCorpus(options?: ConstructorParameters<typeof Corpus>[0]): Corpus {
	const c = new Corpus(options);
	corpora.push(c);
	return c;
}

// ---------------------------------------------------------------------------
// load()
// ---------------------------------------------------------------------------

describe("Corpus — load()", () => {
	it("accepts a CerebrumOrgan and returns this for chaining", () => {
		const corpus = makeCorpus();
		expect(corpus.load(makeNoopOrgan())).toBe(corpus);
	});

	it("collects tool definitions from loaded organs", async () => {
		const corpus = makeCorpus();
		corpus.load(makeToolOrgan(["file_read", "file_grep"]));
		corpus.load(makeToolOrgan(["bash"]));

		let capturedTools: readonly { name: string }[] = [];
		corpus.load({
			kind: "corpus",
			name: "tool-spy",
			tools: [],
			mount: (nerve: CorpusNerve) => {
				return nerve.motor.subscribe("text.input", (e) => {
					capturedTools = (e.payload.tools as { name: string }[]) ?? [];
					nerve.sense.publish({
						type: "text.reply",
						payload: { text: "ok" },
						correlationId: e.correlationId,
						timestamp: Date.now(),
						isError: false,
					});
				});
			},
		});

		await corpus.prompt("hi", { timeoutMs: 1000 });
		expect(capturedTools.map((t) => t.name)).toEqual(["file_read", "file_grep", "bash"]);
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
			kind: "cerebrum",
			name: "counted",
			tools: [],
			mount: (_n: CerebrumNerve) => {
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

describe("Corpus — prompt()", () => {
	it("resolves with reply text from an echo organ", async () => {
		const corpus = makeCorpus();
		corpus.load(makeEchoOrgan());
		const reply = await corpus.prompt("hello", { timeoutMs: 1000 });
		expect(reply).toBe("echo: hello");
	});

	it("correlates concurrent prompts independently", async () => {
		const corpus = makeCorpus();
		corpus.load(makeEchoOrgan());
		const [a, b, c] = await Promise.all([
			corpus.prompt("one", { timeoutMs: 1000 }),
			corpus.prompt("two", { timeoutMs: 1000 }),
			corpus.prompt("three", { timeoutMs: 1000 }),
		]);
		expect([a, b, c].sort()).toEqual(["echo: one", "echo: three", "echo: two"]);
	});

	it("rejects with CorpusTimeoutError when no organ replies", async () => {
		const corpus = makeCorpus();
		corpus.load(makeNoopOrgan());
		await expect(corpus.prompt("ping", { timeoutMs: 20 })).rejects.toBeInstanceOf(CorpusTimeoutError);
	});

	it("rejects immediately if corpus is disposed", async () => {
		const corpus = makeCorpus();
		corpus.dispose();
		await expect(corpus.prompt("hi")).rejects.toThrow("disposed");
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
			kind: "cerebrum",
			name: "tracked",
			tools: [],
			mount: (_n: CerebrumNerve) => () => {
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
