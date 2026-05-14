import type { Nerve, Organ } from "@dpopsuev/alef-spine";
import { afterEach, describe, expect, it } from "vitest";
import { Corpus, CorpusTimeoutError } from "../src/index.js";

// ---------------------------------------------------------------------------
// Minimal stub organs for unit testing Corpus in isolation.
// ---------------------------------------------------------------------------

/** Organ that does nothing — used to verify load() mechanics. */
function makeNoopOrgan(name = "noop"): Organ {
	return {
		name,
		tools: [],
		mount: (_nerve: Nerve) => () => {},
	};
}

/** Organ with tool definitions — used to verify tool collection. */
function makeToolOrgan(toolNames: string[]): Organ {
	return {
		name: "tool-organ",
		tools: toolNames.map((n) => ({
			name: n,
			description: `Tool ${n}`,
			inputSchema: { type: "object", properties: {} },
		})),
		mount: (_nerve: Nerve) => () => {},
	};
}

/**
 * Echo organ — subscribes to Sense/user_message, immediately emits
 * Motor/user_reply with the same text and correlationId.
 * Proves the Corpus round-trip without any real LLM.
 */
function makeEchoOrgan(): Organ {
	return {
		name: "echo",
		tools: [],
		mount: (nerve: Nerve) => {
			const off = nerve.sense.on("user_message", (event) => {
				if (event.type !== "user_message") return;
				nerve.motor.emit({
					type: "user_reply",
					text: `echo: ${event.text}`,
					correlationId: event.correlationId,
					timestamp: Date.now(),
				});
			});
			return off;
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
	it("accepts an organ and returns this for chaining", () => {
		const corpus = makeCorpus();
		const result = corpus.load(makeNoopOrgan());
		expect(result).toBe(corpus);
	});

	it("collects tool definitions from loaded organs", () => {
		const corpus = makeCorpus();
		corpus.load(makeToolOrgan(["file_read", "file_grep"]));
		corpus.load(makeToolOrgan(["bash"]));

		// Tool list is exposed via the user_message event — verify via prompt round-trip
		let capturedTools: readonly { name: string }[] = [];
		corpus.load({
			name: "tool-spy",
			tools: [],
			mount: (nerve) => {
				const off = nerve.sense.on("user_message", (e) => {
					if (e.type === "user_message") capturedTools = e.tools;
					// Reply immediately so prompt() resolves
					nerve.motor.emit({
						type: "user_reply",
						text: "ok",
						correlationId: e.correlationId,
						timestamp: Date.now(),
					});
				});
				return off;
			},
		});

		return corpus.prompt("hi", { timeoutMs: 1000 }).then(() => {
			expect(capturedTools.map((t) => t.name)).toEqual(["file_read", "file_grep", "bash"]);
		});
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
			mount: (_nerve) => {
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
			name: "tracked",
			tools: [],
			mount: (_nerve) => () => {
				unmounted = true;
			},
		});
		corpus.dispose();
		expect(unmounted).toBe(true);
	});

	it("is idempotent — safe to call multiple times", () => {
		const corpus = makeCorpus();
		expect(() => {
			corpus.dispose();
			corpus.dispose();
			corpus.dispose();
		}).not.toThrow();
	});

	it("stops routing after dispose — pending prompt does not resolve", async () => {
		const corpus = makeCorpus();
		let resolved = false;

		// Start a prompt with no organ to reply (will timeout at 50ms)
		const p = corpus.prompt("hi", { timeoutMs: 50 }).then(
			() => {
				resolved = true;
			},
			() => {
				/* timeout expected */
			},
		);

		corpus.dispose();
		await p;
		expect(resolved).toBe(false);
	});
});
