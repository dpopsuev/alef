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

import type { Adapter, Bus, EventMessage, ToolDefinition } from "@dpopsuev/alef-kernel";
import { passthroughSchema } from "@dpopsuev/alef-kernel";
import { AgentController } from "@dpopsuev/alef-runtime";
import { defineStubAdapter } from "@dpopsuev/alef-testkit";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/index.js";

const ANY = passthroughSchema({ type: "object", properties: {} });

function stubFsAdapter() {
	return defineStubAdapter(
		"fs",
		[
			{ name: "fs.read", description: "Read a file", inputSchema: ANY },
			{ name: "fs.grep", description: "Grep files", inputSchema: ANY },
			{ name: "fs.find", description: "Find files", inputSchema: ANY },
		],
		async (_type, payload) => ({ content: "stub", toolCallId: payload.toolCallId }),
	);
}

function stubShellAdapter() {
	return defineStubAdapter(
		"shell",
		[{ name: "shell.exec", description: "Run a command", inputSchema: ANY }],
		async (_type, payload) => ({ stdout: "stub", exitCode: 0, toolCallId: payload.toolCallId }),
	);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function waitEvent(bus: Bus, type: string, toolCallId: string, correlationId: string): Promise<EventMessage> {
	return new Promise((resolve) => {
		const off = bus.event.subscribe(type, (e) => {
			if (e.payload.toolCallId === toolCallId && e.correlationId === correlationId) {
				off();
				resolve(e);
			}
		});
	});
}

function publishCommand(bus: Bus, type: string, payload: Record<string, unknown>, correlationId: string) {
	bus.command.publish({ type, payload, correlationId });
}

// ---------------------------------------------------------------------------
// Mock LLMs
// ---------------------------------------------------------------------------

/** Calls fs.find once, then sends text reply. */
class SingleToolLLM implements Adapter {
	readonly name = "llm";
	readonly tools = [] as const;
	readonly subscriptions = { command: [] as const, event: ["llm.input"] as const };
	readonly sources = [] as const;
	readonly receivedTools: string[] = [];
	readonly receivedResults: unknown[] = [];

	mount(bus: Bus): () => void {
		return bus.event.subscribe("llm.input", async (event) => {
			const corr = event.correlationId;
			const tools = event.payload.tools as ToolDefinition[] | undefined;
			if (tools) this.receivedTools.push(...tools.map((t) => t.name));

			const toolCallId = "tc-001";
			publishCommand(bus, "fs.find", { pattern: "*.ts", toolCallId }, corr);
			const result = await waitEvent(bus, "fs.find", toolCallId, corr);
			this.receivedResults.push(result.payload);

			publishCommand(bus, "llm.response", { text: "Found TypeScript files." }, corr);
		});
	}
}

/** Fan-out: publishes fs.find AND shell.exec simultaneously, collects both before replying. */
class FanOutLLM implements Adapter {
	readonly name = "llm";
	readonly tools = [] as const;
	readonly subscriptions = { command: [] as const, event: ["llm.input"] as const };
	readonly sources = [] as const;
	readonly completionOrder: string[] = [];

	mount(bus: Bus): () => void {
		return bus.event.subscribe("llm.input", async (event) => {
			const corr = event.correlationId;

			publishCommand(bus, "fs.find", { pattern: "*.ts", toolCallId: "tc-find" }, corr);
			publishCommand(bus, "shell.exec", { command: "echo hello", toolCallId: "tc-shell" }, corr);

			const [findResult, shellResult] = await Promise.all([
				waitEvent(bus, "fs.find", "tc-find", corr).then((r) => {
					this.completionOrder.push("fs.find");
					return r;
				}),
				waitEvent(bus, "shell.exec", "tc-shell", corr).then((r) => {
					this.completionOrder.push("shell.exec");
					return r;
				}),
			]);

			void findResult;
			void shellResult;

			publishCommand(bus, "llm.response", { text: "Both done." }, corr);
		});
	}
}

/** Quiescence: no tool calls — publishes text immediately. */
class QuiescentLLM implements Adapter {
	readonly name = "llm";
	readonly tools = [] as const;
	readonly subscriptions = { command: [] as const, event: ["llm.input"] as const };
	readonly sources = [] as const;

	mount(bus: Bus): () => void {
		return bus.event.subscribe("llm.input", (event) => {
			publishCommand(bus, "llm.response", { text: "No tools needed." }, event.correlationId);
		});
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Agent plumbing — full EDA loop", { tags: ["unit"] }, () => {
	it("single tool call round-trip resolves controller.send()", async () => {
		const llm = new SingleToolLLM();
		const agent = new Agent();
		agent.load(llm).load(stubFsAdapter());
		const controller = new AgentController(agent);

		const reply = await controller.send("Find TypeScript files");
		expect(reply).toBe("Found TypeScript files.");
		agent.dispose();
	});

	it("Agent aggregates tool definitions from all loaded adapters", () => {
		const agent = new Agent();
		agent.load(stubFsAdapter()).load(stubShellAdapter());

		const names = agent.tools.map((t) => t.name);
		expect(names).toContain("fs.read");
		expect(names).toContain("fs.grep");
		expect(names).toContain("fs.find");
		expect(names).toContain("shell.exec");
		expect(names).not.toContain("dialog.message");
		agent.dispose();
	});

	it("toolCallId is mirrored in Event result for correlation", async () => {
		const llm = new SingleToolLLM();
		const agent = new Agent();
		agent.load(llm).load(stubFsAdapter());
		const controller = new AgentController(agent);

		await controller.send("go");

		expect(llm.receivedResults).toHaveLength(1);
		expect((llm.receivedResults[0] as { toolCallId: string }).toolCallId).toBe("tc-001");
		agent.dispose();
	});

	it("fan-out: both tool calls execute in parallel, both complete before reply", async () => {
		const llm = new FanOutLLM();
		const agent = new Agent();
		agent.load(llm).load(stubFsAdapter()).load(stubShellAdapter());
		const controller = new AgentController(agent);

		const reply = await controller.send("do both");

		expect(reply).toBe("Both done.");
		expect(llm.completionOrder).toContain("fs.find");
		expect(llm.completionOrder).toContain("shell.exec");
		expect(llm.completionOrder).toHaveLength(2);
		agent.dispose();
	});

	it("quiescence: LLM with no tool calls terminates immediately", async () => {
		const llm = new QuiescentLLM();
		const agent = new Agent();
		const controller = new AgentController(agent, { onReply: () => {} });
		agent.load(llm);

		const reply = await controller.send("anything");
		expect(reply).toBe("No tools needed.");
		agent.dispose();
	});
});
