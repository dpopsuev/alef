/**
 * LLM pipeline integration tests.
 *
 * Exercises the parts ScriptedReasoner cannot reach:
 *   - prepareStep called by real organ-llm; output visible in the LLM context
 *   - motor/llm.phase pipeline (ToolShell progressive disclosure)
 *   - Retry on transient error
 *   - budget.cancel abort
 *
 * Uses registerFauxProvider — no HTTP, no API key, deterministic responses.
 * All tests run in-process; no subprocesses, no real LLM.
 */

import { type FauxResponseFactory, fauxAssistantMessage, registerFauxProvider } from "@dpopsuev/alef-llm";
import { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import { createAgentLoop, createLlmPipeline } from "@dpopsuev/alef-organ-llm";
import { Agent } from "@dpopsuev/alef-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { Directives } from "../src/directives.js";
import { buildPrepareStep, createDefaultDirectives } from "../src/prompt.js";
import { createToolShellOrgan } from "../src/tool-shell.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SEND_TIMEOUT = 5_000;

/** Minimal agent: organ-llm with faux LLM + DialogOrgan. */
function makeAgent(
	opts: { prepareStep?: Parameters<typeof buildPrepareStep>[0]; phaseTimeoutMs?: number; maxRetries?: number } = {},
) {
	const faux = registerFauxProvider();
	const agent = new Agent();
	const dialog = new DialogOrgan({ sink: () => {} });
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const _prepareStep = opts.prepareStep ? (buildPrepareStep(opts.prepareStep, 100_000) as any) : undefined;

	const llm = createAgentLoop({
		model: faux.getModel(),
		apiKey: "faux",
		phaseTimeoutMs: opts.phaseTimeoutMs,
		maxRetries: opts.maxRetries ?? 0,
	});

	agent.load(dialog).load(llm);
	return { faux, agent, dialog };
}

const disposes: Array<() => void> = [];
afterEach(() => {
	for (const d of disposes.splice(0)) d();
});

// ---------------------------------------------------------------------------
// prepareStep → LLM context
// ---------------------------------------------------------------------------

describe("prepareStep → LLM context", { tags: ["unit"] }, () => {
	it("system message from directives is in ctx.messages at callLLM time", async () => {
		const directives = new Directives();
		directives.register({ id: "sentinel", priority: 0, content: "SENTINEL_DIRECTIVE_XYZ", enabled: true });

		let capturedSystem: string | undefined;
		const factory: FauxResponseFactory = (ctx) => {
			const sys = ctx.messages.find((m) => (m as { role: string }).role === "system");
			capturedSystem = sys ? String((sys as { content: unknown }).content) : undefined;
			return fauxAssistantMessage("ok");
		};

		const { faux, agent, dialog } = makeAgent({ prepareStep: directives });
		faux.setResponses([factory]);
		disposes.push(() => {
			agent.dispose();
			faux.unregister();
		});

		await agent.ready();
		await dialog.send("hello", "human", SEND_TIMEOUT);

		expect(capturedSystem).toContain("SENTINEL_DIRECTIVE_XYZ");
	});

	it("live directive change is reflected on the next turn without restart", async () => {
		const directives = new Directives();
		directives.register({ id: "d", priority: 0, content: "VERSION_ONE", enabled: true });

		const captured: string[] = [];
		const factory: FauxResponseFactory = (ctx) => {
			const sys = ctx.messages.find((m) => (m as { role: string }).role === "system");
			captured.push(String((sys as { content: unknown })?.content ?? ""));
			return fauxAssistantMessage("ok");
		};

		const { faux, agent, dialog } = makeAgent({ prepareStep: directives });
		faux.setResponses([factory, factory]);
		disposes.push(() => {
			agent.dispose();
			faux.unregister();
		});

		await agent.ready();
		await dialog.send("turn 1", "human", SEND_TIMEOUT);

		directives.replace("d", "VERSION_TWO");
		await dialog.send("turn 2", "human", SEND_TIMEOUT);

		expect(captured[0]).toContain("VERSION_ONE");
		expect(captured[1]).toContain("VERSION_TWO");
	});

	it("disabled directive does not appear in the LLM context", async () => {
		const directives = new Directives();
		directives.register({ id: "visible", priority: 0, content: "VISIBLE_RULE", enabled: true });
		directives.register({ id: "hidden", priority: 1, content: "HIDDEN_RULE", enabled: false });

		let capturedSystem: string | undefined;
		const factory: FauxResponseFactory = (ctx) => {
			const sys = ctx.messages.find((m) => (m as { role: string }).role === "system");
			capturedSystem = String((sys as { content: unknown })?.content ?? "");
			return fauxAssistantMessage("ok");
		};

		const { faux, agent, dialog } = makeAgent({ prepareStep: directives });
		faux.setResponses([factory]);
		disposes.push(() => {
			agent.dispose();
			faux.unregister();
		});

		await agent.ready();
		await dialog.send("hello", "human", SEND_TIMEOUT);

		expect(capturedSystem).toContain("VISIBLE_RULE");
		expect(capturedSystem).not.toContain("HIDDEN_RULE");
	});

	it("default directives include format rules in the LLM context", async () => {
		const directives = createDefaultDirectives({ tools: [], cwd: "/test" });

		let capturedSystem: string | undefined;
		const factory: FauxResponseFactory = (ctx) => {
			const sys = ctx.messages.find((m) => (m as { role: string }).role === "system");
			capturedSystem = String((sys as { content: unknown })?.content ?? "");
			return fauxAssistantMessage("ok");
		};

		const { faux, agent, dialog } = makeAgent({ prepareStep: directives });
		faux.setResponses([factory]);
		disposes.push(() => {
			agent.dispose();
			faux.unregister();
		});

		await agent.ready();
		await dialog.send("hello", "human", SEND_TIMEOUT);

		expect(capturedSystem).toContain("No emojis");
		expect(capturedSystem).toContain("No filler");
		expect(capturedSystem).toContain("No preamble");
		expect(capturedSystem).toContain("You are Alef");
	});
});

// ---------------------------------------------------------------------------
// motor/llm.phase pipeline
// ---------------------------------------------------------------------------

describe("motor/llm.phase pipeline", { tags: ["unit"] }, () => {
	it("motor/llm.phase fires and its messages include the system message", async () => {
		const directives = new Directives();
		directives.register({ id: "d", priority: 0, content: "PHASE_SENTINEL", enabled: true });

		let phaseMessages: unknown[] | undefined;
		const { faux, agent, dialog } = makeAgent({
			prepareStep: directives,
			phaseTimeoutMs: 100,
		});
		faux.setResponses([fauxAssistantMessage("done")]);
		disposes.push(() => {
			agent.dispose();
			faux.unregister();
		});

		agent.subscribeMotor("llm.phase", (event) => {
			phaseMessages = event.payload.messages as unknown[];
		});

		await agent.ready();
		await dialog.send("hello", "human", SEND_TIMEOUT);

		expect(phaseMessages).toBeDefined();
		const sys = (phaseMessages ?? []).find((m) => (m as { role: string }).role === "system");
		expect(String((sys as { content: unknown })?.content)).toContain("PHASE_SENTINEL");
	});

	it("ToolShell phaseStage adds tools.describe to ctx.tools on turn 1", async () => {
		const directives = new Directives();
		directives.register({ id: "d", priority: 0, content: "rules", enabled: true });

		const toolShell = createToolShellOrgan({ tools: [] });

		let capturedTools: unknown[] | undefined;
		const factory: FauxResponseFactory = (ctx) => {
			capturedTools = ctx.tools;
			return fauxAssistantMessage("done");
		};

		const { faux, agent, dialog } = makeAgent({
			prepareStep: directives,
			phaseTimeoutMs: 100,
		});
		faux.setResponses([factory]);
		disposes.push(() => {
			agent.dispose();
			faux.unregister();
		});

		agent.load(toolShell);
		agent.load(createLlmPipeline());

		await agent.ready();
		await dialog.send("hello", "human", SEND_TIMEOUT);

		const names = (capturedTools ?? []).map((t) => (t as { name: string }).name);
		// organ-llm substitutes dots with underscores for the LLM wire format.
		expect(names.some((n) => n === "tools.describe" || n === "tools_describe")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Retry on transient error
// ---------------------------------------------------------------------------

describe("retry on transient error", { tags: ["unit"] }, () => {
	it("retries a rate-limit error and returns the second response", async () => {
		const { faux, agent, dialog } = makeAgent({ maxRetries: 2 });
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate_limit exceeded" }),
			fauxAssistantMessage("success after retry"),
		]);
		disposes.push(() => {
			agent.dispose();
			faux.unregister();
		});

		await agent.ready();
		const reply = await dialog.send("hello", "human", SEND_TIMEOUT);

		expect(reply).toBe("success after retry");
		expect(faux.state.callCount).toBe(2);
	});

	it("does not retry a non-transient error", async () => {
		const { faux, agent, dialog } = makeAgent({ maxRetries: 2 });
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_request: bad input" }),
			fauxAssistantMessage("should not reach"),
		]);
		disposes.push(() => {
			agent.dispose();
			faux.unregister();
		});

		await agent.ready();
		await dialog.send("hello", "human", SEND_TIMEOUT);

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

		const { faux, agent, dialog } = makeAgent();
		faux.setResponses([factory]);
		disposes.push(() => {
			agent.dispose();
			faux.unregister();
		});

		await agent.ready();

		const sendPromise = dialog.send("hello", "human", SEND_TIMEOUT);
		await new Promise<void>((r) => setTimeout(r, 50));
		agent.publishSense({
			type: "budget.cancel",
			correlationId: "*",
			payload: { reason: "maxElapsedMs", limitMs: 0 },
			isError: false,
		});

		await sendPromise;
		expect(faux.state.callCount).toBe(1);
	});
});
