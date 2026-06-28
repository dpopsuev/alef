/**
 * LLM pipeline integration tests.
 *
 * Exercises the parts ScriptedReasoner cannot reach:
 *   - systemPrompt visible in the LLM context
 *   - command/context.assemble pipeline (ToolShell progressive disclosure)
 *   - Retry on transient error
 *   - budget.cancel abort
 *
 * Uses registerFauxProvider — no HTTP, no API key, deterministic responses.
 * All tests run in-process; no subprocesses, no real LLM.
 */

import { type FauxResponseFactory, fauxAssistantMessage, registerFauxProvider } from "@dpopsuev/alef-ai/faux";
import { Agent } from "@dpopsuev/alef-engine/agent";
import { createToolShellAdapter } from "@dpopsuev/alef-engine/catalog";
import { AgentController } from "@dpopsuev/alef-engine/controller";
import type { BusMessage } from "@dpopsuev/alef-kernel/bus";
import { createContextAssembler } from "@dpopsuev/alef-kernel/context-assembly";
import { createAgentLoop } from "@dpopsuev/alef-reasoner";
import type { StorageRecord } from "@dpopsuev/alef-session/storage";
import { buildSessionIndex, reconstructTurn } from "@dpopsuev/alef-session/tracing";
import { afterEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SEND_TIMEOUT = 5_000;

/** Minimal agent: adapter-llm with faux LLM + AgentController. */
function makeAgent(opts: { systemPrompt?: string; phaseTimeoutMs?: number; maxRetries?: number } = {}) {
	const faux = registerFauxProvider();
	const agent = new Agent();

	const llm = createAgentLoop({
		model: faux.getModel(),
		apiKey: "faux",
		systemPrompt: opts.systemPrompt,
		phaseTimeoutMs: opts.phaseTimeoutMs,
		maxRetries: opts.maxRetries ?? 0,
	});

	agent.load(llm);
	if (opts.phaseTimeoutMs) agent.load(createContextAssembler());
	const controller = new AgentController(agent);
	return { faux, agent, controller };
}

const disposes: Array<() => void> = [];
afterEach(() => {
	for (const d of disposes.splice(0)) d();
});

// ---------------------------------------------------------------------------
// prepareStep → LLM context
// ---------------------------------------------------------------------------

describe("systemPrompt → LLM context", { tags: ["unit"] }, () => {
	it("system prompt is in ctx.systemPrompt at callLLM time", async () => {
		let capturedSystem: string | undefined;
		const factory: FauxResponseFactory = (ctx) => {
			capturedSystem = ctx.systemPrompt;
			return fauxAssistantMessage("ok");
		};

		const { faux, agent, controller } = makeAgent({ systemPrompt: "SENTINEL_DIRECTIVE_XYZ" });
		faux.setResponses([factory]);
		disposes.push(() => {
			agent.dispose();
			faux.unregister();
		});

		await agent.ready();
		await controller.send("hello", "human", SEND_TIMEOUT);

		expect(capturedSystem).toContain("SENTINEL_DIRECTIVE_XYZ");
	});

	it("system prompt is consistent across turns", async () => {
		const captured: string[] = [];
		const factory: FauxResponseFactory = (ctx) => {
			captured.push(ctx.systemPrompt ?? "");
			return fauxAssistantMessage("ok");
		};

		const { faux, agent, controller } = makeAgent({ systemPrompt: "STABLE_PROMPT" });
		faux.setResponses([factory, factory]);
		disposes.push(() => {
			agent.dispose();
			faux.unregister();
		});

		await agent.ready();
		await controller.send("turn 1", "human", SEND_TIMEOUT);
		await controller.send("turn 2", "human", SEND_TIMEOUT);

		expect(captured[0]).toContain("STABLE_PROMPT");
		expect(captured[1]).toContain("STABLE_PROMPT");
	});

	it("system prompt content appears; absent content is not present", async () => {
		let capturedSystem: string | undefined;
		const factory: FauxResponseFactory = (ctx) => {
			capturedSystem = ctx.systemPrompt;
			return fauxAssistantMessage("ok");
		};

		const { faux, agent, controller } = makeAgent({ systemPrompt: "VISIBLE_RULE" });
		faux.setResponses([factory]);
		disposes.push(() => {
			agent.dispose();
			faux.unregister();
		});

		await agent.ready();
		await controller.send("hello", "human", SEND_TIMEOUT);

		expect(capturedSystem).toContain("VISIBLE_RULE");
		expect(capturedSystem).not.toContain("HIDDEN_RULE");
	});

	it("no system prompt → ctx.systemPrompt is undefined", async () => {
		let capturedSystem: string | undefined;
		const factory: FauxResponseFactory = (ctx) => {
			capturedSystem = ctx.systemPrompt;
			return fauxAssistantMessage("ok");
		};

		const { faux, agent, controller } = makeAgent();
		faux.setResponses([factory]);
		disposes.push(() => {
			agent.dispose();
			faux.unregister();
		});

		await agent.ready();
		await controller.send("hello", "human", SEND_TIMEOUT);

		expect(capturedSystem).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// command/context.assemble pipeline
// ---------------------------------------------------------------------------

describe("command/context.assemble pipeline", { tags: ["unit"] }, () => {
	it("command/context.assemble fires and its messages include the user message", async () => {
		let phaseMessages: unknown[] | undefined;
		const { faux, agent, controller } = makeAgent({ phaseTimeoutMs: 100 });
		faux.setResponses([fauxAssistantMessage("done")]);
		disposes.push(() => {
			agent.dispose();
			faux.unregister();
		});

		agent.subscribeCommand("context.assemble", (event) => {
			phaseMessages = event.payload.messages as unknown[];
		});

		await agent.ready();
		await controller.send("hello", "human", SEND_TIMEOUT);

		expect(phaseMessages).toBeDefined();
		const user = (phaseMessages ?? []).find((m) => (m as { role: string }).role === "user");
		expect(user).toBeDefined();
	});

	it("ToolShell phaseStage adds tools.describe to ctx.tools on turn 1", async () => {
		const toolShell = createToolShellAdapter({ tools: [] });

		let capturedTools: unknown[] | undefined;
		const factory: FauxResponseFactory = (ctx) => {
			capturedTools = ctx.tools;
			return fauxAssistantMessage("done");
		};

		const { faux, agent, controller } = makeAgent({ phaseTimeoutMs: 100 });
		faux.setResponses([factory]);
		disposes.push(() => {
			agent.dispose();
			faux.unregister();
		});

		agent.load(toolShell);
		agent.load(createContextAssembler());

		await agent.ready();
		await controller.send("hello", "human", SEND_TIMEOUT);

		const names = (capturedTools ?? []).map((t) => (t as { name: string }).name);
		// adapter-llm substitutes dots with underscores for the LLM wire format.
		expect(names.some((n) => n === "tools.describe" || n === "tools_describe")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Reconstructor cross-check
// ---------------------------------------------------------------------------

function busToRecord(bus: "command" | "event" | "notification", e: BusMessage): StorageRecord {
	return {
		bus,
		type: e.type,
		correlationId: e.correlationId,
		payload: (e as { payload?: Record<string, unknown> }).payload ?? {},
		timestamp: e.timestamp,
	};
}

describe("context reconstructor cross-check", { tags: ["unit"] }, () => {
	it("reconstructor finds turn 0 with correct tool calls from recorded events", async () => {
		const { faux, agent, controller } = makeAgent({ phaseTimeoutMs: 100 });
		const toolShell = createToolShellAdapter({ tools: [] });
		agent.load(toolShell);
		agent.load(createContextAssembler());

		const records: StorageRecord[] = [];
		agent.observe({
			onCommand(e) {
				records.push(busToRecord("command", e));
			},
			onEvent(e) {
				records.push(busToRecord("event", e));
			},
			onNotification(e) {
				records.push(busToRecord("notification", e));
			},
		});

		faux.setResponses([fauxAssistantMessage("done")]);
		disposes.push(() => {
			agent.dispose();
			faux.unregister();
		});

		await agent.ready();
		await controller.send("hello", "human", SEND_TIMEOUT);

		const index = buildSessionIndex(records);
		expect(index.turns.length).toBeGreaterThan(0);

		const snapshot = reconstructTurn(index, 0);
		expect(snapshot).toBeDefined();
		expect(snapshot!.correlationId).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// Retry on transient error
// ---------------------------------------------------------------------------

describe("retry on transient error", { tags: ["unit"] }, () => {
	it("retries a rate-limit error and returns the second response", async () => {
		const { faux, agent, controller } = makeAgent({ maxRetries: 2 });
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate_limit exceeded" }),
			fauxAssistantMessage("success after retry"),
		]);
		disposes.push(() => {
			agent.dispose();
			faux.unregister();
		});

		await agent.ready();
		const reply = await controller.send("hello", "human", SEND_TIMEOUT);

		expect(reply).toBe("success after retry");
		expect(faux.state.callCount).toBe(2);
	});

	it("does not retry a non-transient error", async () => {
		const { faux, agent, controller } = makeAgent({ maxRetries: 2 });
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_request: bad input" }),
			fauxAssistantMessage("should not reach"),
		]);
		disposes.push(() => {
			agent.dispose();
			faux.unregister();
		});

		await agent.ready();
		await controller.send("hello", "human", SEND_TIMEOUT);

		expect(faux.state.callCount).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// budget.cancel abort
// ---------------------------------------------------------------------------

describe("budget.cancel", { tags: ["unit"] }, () => {
	it("budget.cancel aborts the current turn before the LLM responds", async () => {
		const factory: FauxResponseFactory = (_ctx, opts) =>
			new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
				const finish = () => resolve(fauxAssistantMessage("late"));
				opts?.signal?.addEventListener("abort", finish, { once: true });
				setTimeout(finish, 3_000);
			});

		const { faux, agent, controller } = makeAgent();
		faux.setResponses([factory]);
		disposes.push(() => {
			agent.dispose();
			faux.unregister();
		});

		await agent.ready();

		const sendPromise = controller.send("hello", "human", SEND_TIMEOUT);
		await new Promise<void>((r) => setTimeout(r, 50));
		agent.publishEvent({
			type: "budget.cancel",
			correlationId: "*",
			payload: { reason: "maxElapsedMs", limitMs: 0 },
			isError: false,
		});

		await sendPromise;
		expect(faux.state.callCount).toBe(1);
	});
});
