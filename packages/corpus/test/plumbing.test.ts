/**
 * Plumbing tests — full EDA event loop without a real LLM.
 *
 * Tests:
 *   - Single tool call round-trip
 *   - Tool definitions delivered to LLM
 *   - toolCallId correlation
 *   - Fan-out: two tool calls published simultaneously, both results arrive before LLM continues
 *   - Quiescence: loop terminates when LLM produces zero tool calls
 */

import type { CerebrumNerve, CerebrumOrgan, SenseEvent, ToolDefinition } from "@dpopsuev/alef-spine";
import { describe, expect, it } from "vitest";
import { createFsOrgan } from "../../organ-fs/src/organ.js";
import { createShellOrgan } from "../../organ-shell/src/organ.js";
import { TextMessageOrgan } from "../../organ-text-message/src/index.js";
import { Corpus } from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function waitSense(nerve: CerebrumNerve, type: string, toolCallId: string, correlationId: string): Promise<SenseEvent> {
	return new Promise((resolve) => {
		const off = nerve.sense.subscribe(type, (e) => {
			if (e.payload.toolCallId === toolCallId && e.correlationId === correlationId) {
				off();
				resolve(e);
			}
		});
	});
}

function publishMotor(nerve: CerebrumNerve, type: string, payload: Record<string, unknown>, correlationId: string) {
	nerve.motor.publish({ type, payload, correlationId, timestamp: Date.now() });
}

// ---------------------------------------------------------------------------
// Mock LLMs
// ---------------------------------------------------------------------------

/** Calls fs.find once, then sends text reply. */
class SingleToolLLM implements CerebrumOrgan {
	readonly kind = "cerebrum" as const;
	readonly name = "llm";
	readonly tools = [] as const;
	readonly receivedTools: string[] = [];
	readonly receivedResults: unknown[] = [];

	mount(nerve: CerebrumNerve): () => void {
		return nerve.sense.subscribe("text.input", async (event) => {
			const corr = event.correlationId;
			this.receivedTools.push(...(event.payload.tools as ToolDefinition[]).map((t) => t.name));

			const toolCallId = "tc-001";
			publishMotor(nerve, "fs.find", { pattern: "*.ts", toolCallId }, corr);
			const result = await waitSense(nerve, "fs.find", toolCallId, corr);
			this.receivedResults.push(result.payload);

			publishMotor(nerve, "text.message", { text: "Found TypeScript files." }, corr);
		});
	}
}

/** Fan-out: publishes fs.find AND shell.exec simultaneously, collects both before replying. */
class FanOutLLM implements CerebrumOrgan {
	readonly kind = "cerebrum" as const;
	readonly name = "llm";
	readonly tools = [] as const;
	readonly completionOrder: string[] = [];
	finishedAt = 0;

	mount(nerve: CerebrumNerve): () => void {
		return nerve.sense.subscribe("text.input", async (event) => {
			const corr = event.correlationId;

			// Publish both simultaneously
			publishMotor(nerve, "fs.find", { pattern: "*.ts", toolCallId: "tc-find" }, corr);
			publishMotor(nerve, "shell.exec", { command: "echo hello", toolCallId: "tc-shell" }, corr);

			// Await both in parallel
			const [findResult, shellResult] = await Promise.all([
				waitSense(nerve, "fs.find", "tc-find", corr).then((r) => {
					this.completionOrder.push("fs.find");
					return r;
				}),
				waitSense(nerve, "shell.exec", "tc-shell", corr).then((r) => {
					this.completionOrder.push("shell.exec");
					return r;
				}),
			]);

			this.finishedAt = Date.now();
			void findResult;
			void shellResult;

			publishMotor(nerve, "text.message", { text: "Both done." }, corr);
		});
	}
}

/** Quiescence: produces zero tool calls — just sends text directly. */
class QuiescentLLM implements CerebrumOrgan {
	readonly kind = "cerebrum" as const;
	readonly name = "llm";
	readonly tools = [] as const;

	mount(nerve: CerebrumNerve): () => void {
		return nerve.sense.subscribe("text.input", (event) => {
			// No tool calls — publish text immediately. Loop should terminate.
			publishMotor(nerve, "text.message", { text: "No tools needed." }, event.correlationId);
		});
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Corpus plumbing — full EDA loop", () => {
	it("single tool call round-trip resolves corpus.prompt()", async () => {
		const llm = new SingleToolLLM();
		const corpus = new Corpus({ timeoutMs: 5_000 });
		corpus
			.load(new TextMessageOrgan())
			.load(llm)
			.load(createFsOrgan({ cwd: process.cwd() }));

		const reply = await corpus.prompt("Find TypeScript files");
		expect(reply).toBe("Found TypeScript files.");
		corpus.dispose();
	});

	it("LLM receives tool definitions from all loaded organs", async () => {
		const llm = new SingleToolLLM();
		const corpus = new Corpus({ timeoutMs: 5_000 });
		corpus
			.load(new TextMessageOrgan())
			.load(llm)
			.load(createFsOrgan({ cwd: process.cwd() }))
			.load(createShellOrgan({ cwd: process.cwd() }));

		await corpus.prompt("go");

		expect(llm.receivedTools).toContain("fs.read");
		expect(llm.receivedTools).toContain("fs.grep");
		expect(llm.receivedTools).toContain("fs.find");
		expect(llm.receivedTools).toContain("shell.exec");
		expect(llm.receivedTools).toContain("text.message");
		corpus.dispose();
	});

	it("toolCallId is mirrored in Sense result for correlation", async () => {
		const llm = new SingleToolLLM();
		const corpus = new Corpus({ timeoutMs: 5_000 });
		corpus
			.load(new TextMessageOrgan())
			.load(llm)
			.load(createFsOrgan({ cwd: process.cwd() }));

		await corpus.prompt("go");

		expect(llm.receivedResults).toHaveLength(1);
		expect((llm.receivedResults[0] as { toolCallId: string }).toolCallId).toBe("tc-001");
		corpus.dispose();
	});

	it("fan-out: both tool calls execute in parallel, both complete before reply", async () => {
		const llm = new FanOutLLM();
		const corpus = new Corpus({ timeoutMs: 5_000 });
		corpus
			.load(new TextMessageOrgan())
			.load(llm)
			.load(createFsOrgan({ cwd: process.cwd() }))
			.load(createShellOrgan({ cwd: process.cwd() }));

		const reply = await corpus.prompt("do both");

		expect(reply).toBe("Both done.");
		// Both Sense events arrived before the reply was sent
		expect(llm.completionOrder).toContain("fs.find");
		expect(llm.completionOrder).toContain("shell.exec");
		expect(llm.completionOrder).toHaveLength(2);
		corpus.dispose();
	});

	it("quiescence: LLM with no tool calls terminates immediately", async () => {
		const llm = new QuiescentLLM();
		const corpus = new Corpus({ timeoutMs: 5_000 });
		corpus.load(new TextMessageOrgan()).load(llm);

		const reply = await corpus.prompt("anything");
		expect(reply).toBe("No tools needed.");
		corpus.dispose();
	});
});
