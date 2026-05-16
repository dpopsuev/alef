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

import type { Nerve, Organ, SenseEvent, ToolDefinition } from "@dpopsuev/alef-spine";
import { describe, expect, it } from "vitest";
import { DialogOrgan } from "../../organ-dialog/src/organ.js";
import { createFsOrgan } from "../../organ-fs/src/organ.js";
import { createShellOrgan } from "../../organ-shell/src/organ.js";
import { Agent } from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function waitSense(nerve: Nerve, type: string, toolCallId: string, correlationId: string): Promise<SenseEvent> {
	return new Promise((resolve) => {
		const off = nerve.sense.subscribe(type, (e) => {
			if (e.payload.toolCallId === toolCallId && e.correlationId === correlationId) {
				off();
				resolve(e);
			}
		});
	});
}

function publishMotor(nerve: Nerve, type: string, payload: Record<string, unknown>, correlationId: string) {
	nerve.motor.publish({ type, payload, correlationId, timestamp: Date.now() });
}

// ---------------------------------------------------------------------------
// Mock LLMs
// ---------------------------------------------------------------------------

/** Calls fs.find once, then sends text reply. */
class SingleToolLLM implements Organ {
	readonly name = "llm";
	readonly tools = [] as const;
	readonly subscriptions = { motor: [] as const, sense: ["dialog.message"] as const };
	readonly receivedTools: string[] = [];
	readonly receivedResults: unknown[] = [];

	mount(nerve: Nerve): () => void {
		return nerve.sense.subscribe("dialog.message", async (event) => {
			const corr = event.correlationId;
			this.receivedTools.push(...(event.payload.tools as ToolDefinition[]).map((t) => t.name));

			const toolCallId = "tc-001";
			publishMotor(nerve, "fs.find", { pattern: "*.ts", toolCallId }, corr);
			const result = await waitSense(nerve, "fs.find", toolCallId, corr);
			this.receivedResults.push(result.payload);

			publishMotor(nerve, "dialog.message", { text: "Found TypeScript files." }, corr);
		});
	}
}

/** Fan-out: publishes fs.find AND shell.exec simultaneously, collects both before replying. */
class FanOutLLM implements Organ {
	readonly name = "llm";
	readonly tools = [] as const;
	readonly subscriptions = { motor: [] as const, sense: ["dialog.message"] as const };
	readonly completionOrder: string[] = [];

	mount(nerve: Nerve): () => void {
		return nerve.sense.subscribe("dialog.message", async (event) => {
			const corr = event.correlationId;

			publishMotor(nerve, "fs.find", { pattern: "*.ts", toolCallId: "tc-find" }, corr);
			publishMotor(nerve, "shell.exec", { command: "echo hello", toolCallId: "tc-shell" }, corr);

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

			void findResult;
			void shellResult;

			publishMotor(nerve, "dialog.message", { text: "Both done." }, corr);
		});
	}
}

/** Quiescence: no tool calls — publishes text immediately. */
class QuiescentLLM implements Organ {
	readonly name = "llm";
	readonly tools = [] as const;
	readonly subscriptions = { motor: [] as const, sense: ["dialog.message"] as const };

	mount(nerve: Nerve): () => void {
		return nerve.sense.subscribe("dialog.message", (event) => {
			publishMotor(nerve, "dialog.message", { text: "No tools needed." }, event.correlationId);
		});
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Agent plumbing — full EDA loop", () => {
	it("single tool call round-trip resolves dialog.send()", async () => {
		const llm = new SingleToolLLM();
		const dialog = new DialogOrgan({ sink: () => {} });
		const agent = new Agent();
		agent
			.load(dialog)
			.load(llm)
			.load(createFsOrgan({ cwd: process.cwd() }));

		const reply = await dialog.send("Find TypeScript files");
		expect(reply).toBe("Found TypeScript files.");
		agent.dispose();
	});

	it("LLM receives tool definitions from all loaded organs", async () => {
		const llm = new SingleToolLLM();
		const agent = new Agent();
		const dialog = new DialogOrgan({ sink: () => {}, getTools: () => agent.tools });
		agent
			.load(dialog)
			.load(llm)
			.load(createFsOrgan({ cwd: process.cwd() }))
			.load(createShellOrgan({ cwd: process.cwd() }));

		await dialog.send("go");

		expect(llm.receivedTools).toContain("fs.read");
		expect(llm.receivedTools).toContain("fs.grep");
		expect(llm.receivedTools).toContain("fs.find");
		expect(llm.receivedTools).toContain("shell.exec");
		expect(llm.receivedTools).toContain("dialog.message");
		agent.dispose();
	});

	it("toolCallId is mirrored in Sense result for correlation", async () => {
		const llm = new SingleToolLLM();
		const dialog = new DialogOrgan({ sink: () => {} });
		const agent = new Agent();
		agent
			.load(dialog)
			.load(llm)
			.load(createFsOrgan({ cwd: process.cwd() }));

		await dialog.send("go");

		expect(llm.receivedResults).toHaveLength(1);
		expect((llm.receivedResults[0] as { toolCallId: string }).toolCallId).toBe("tc-001");
		agent.dispose();
	});

	it("fan-out: both tool calls execute in parallel, both complete before reply", async () => {
		const llm = new FanOutLLM();
		const dialog = new DialogOrgan({ sink: () => {} });
		const agent = new Agent();
		agent
			.load(dialog)
			.load(llm)
			.load(createFsOrgan({ cwd: process.cwd() }))
			.load(createShellOrgan({ cwd: process.cwd() }));

		const reply = await dialog.send("do both");

		expect(reply).toBe("Both done.");
		expect(llm.completionOrder).toContain("fs.find");
		expect(llm.completionOrder).toContain("shell.exec");
		expect(llm.completionOrder).toHaveLength(2);
		agent.dispose();
	});

	it("quiescence: LLM with no tool calls terminates immediately", async () => {
		const llm = new QuiescentLLM();
		const agent = new Agent();
		const dialog = new DialogOrgan({ sink: () => {}, getTools: () => agent.tools });
		agent.load(dialog).load(llm);

		const reply = await dialog.send("anything");
		expect(reply).toBe("No tools needed.");
		agent.dispose();
	});
});
