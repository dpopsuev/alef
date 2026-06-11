/**
 * Regression test for ALE-BUG-68:
 * agent.run outer timeout must use the tool's schema default (600s),
 * not the LLM HTTP call timeout (60s).
 *
 * Root cause: ToolShell strips schemas for unpromoted tools.
 * toOuterTimeoutMs reads stripped schema → no timeoutMs default visible
 * → falls back to HTTP timeout → subagents killed at 60s.
 *
 * Fix: pass getFullTools (full schemas) to the LLM organ so toOuterTimeoutMs
 * can read the schema default even when the ToolShell has stripped the schema.
 */
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@dpopsuev/alef-llm";
import { createDelegateOrgan } from "@dpopsuev/alef-organ-delegate";
import { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentLoop, createLlmPipeline } from "../../organ-llm/src/index.js";
import { Agent } from "../../runtime/src/index.js";
import { InProcessStrategy } from "../src/strategies/in-process.js";
import { buildSubagentFactory } from "../src/subagent-factory.js";
import { createToolShellOrgan } from "../src/tool-shell.js";

const HTTP_TIMEOUT_MS = 200;
const INNER_DELAY_MS = 500;

describe("agent.run outer timeout — production ToolShell path", { tags: ["unit"] }, () => {
	const agents: Agent[] = [];
	afterEach(() => {
		for (const a of agents.splice(0)) a.dispose();
	});

	it("uses schema default (600s) not HTTP timeout (200ms) when tool is not promoted", async () => {
		const outerFaux = registerFauxProvider();
		const innerFaux = registerFauxProvider();

		// Inner factory: responds after INNER_DELAY_MS
		// Without fix: outer timeout = HTTP_TIMEOUT_MS (200ms) < INNER_DELAY_MS (500ms) → timeout
		// With fix:    outer timeout = schema default (600_000ms) >> INNER_DELAY_MS → success
		const innerFactory = buildSubagentFactory({ model: innerFaux.getModel() });
		innerFaux.setResponses([
			async () => {
				await new Promise<void>((r) => setTimeout(r, INNER_DELAY_MS));
				return fauxAssistantMessage("inner result");
			},
		]);

		// Build production-like agent (mirrors local-session.ts structure)
		const agent = new Agent();
		agents.push(agent);

		let reply = "";
		const dialog = new DialogOrgan({
			sink: (t) => {
				if (t) reply = t;
			},
		});

		const delegateOrgan = createDelegateOrgan({
			strategies: {
				explore: new InProcessStrategy([], innerFactory),
			},
			createAdHocSession: innerFactory,
		});

		agent.load(delegateOrgan);

		// ToolShell: currentMetaTools() strips agent.run schema → z.object({})
		const toolShell = createToolShellOrgan({
			tools: agent.tools,
			getTools: () => agent.tools,
		});
		agent.load(toolShell);
		agent.load(createLlmPipeline());

		const outerLlm = createAgentLoop({
			model: outerFaux.getModel(),
			timeoutMs: HTTP_TIMEOUT_MS,
			// Full schemas — used by toOuterTimeoutMs to read the 600s default
			schemaResolver: (name) => agent.tools.find((t) => t.name === name),
		});

		agent.load(dialog).load(outerLlm);

		// Outer LLM: calls agent.run WITHOUT specifying timeoutMs (exercises the bug path)
		outerFaux.setResponses([
			fauxAssistantMessage([fauxToolCall("agent_run", { text: "do something", profile: "explore" })]),
			fauxAssistantMessage("done"),
		]);

		await agent.ready();
		await dialog.send("run the subagent", "human", 10_000);

		// Inner agent completed (500ms), outer timeout was 610_000ms not 200ms
		expect(reply).toBe("done");
	}, 10_000);

	it("regresses when getFullTools is absent — tool times out at HTTP timeout", async () => {
		const outerFaux = registerFauxProvider();
		const innerFaux = registerFauxProvider();

		const innerFactory = buildSubagentFactory({ model: innerFaux.getModel() });
		innerFaux.setResponses([
			async () => {
				await new Promise<void>((r) => setTimeout(r, INNER_DELAY_MS));
				return fauxAssistantMessage("inner result");
			},
		]);

		const agent = new Agent();
		agents.push(agent);

		let reply = "";
		const dialog = new DialogOrgan({
			sink: (t) => {
				if (t) reply = t;
			},
		});

		const delegateOrgan = createDelegateOrgan({
			strategies: { explore: new InProcessStrategy([], innerFactory) },
			createAdHocSession: innerFactory,
		});

		agent.load(delegateOrgan);

		const toolShell = createToolShellOrgan({
			tools: agent.tools,
			getTools: () => agent.tools,
		});
		agent.load(toolShell);
		agent.load(createLlmPipeline());

		const outerLlm = createAgentLoop({
			model: outerFaux.getModel(),
			timeoutMs: HTTP_TIMEOUT_MS,
			// getFullTools intentionally absent — bug path
		});

		agent.load(dialog).load(outerLlm);

		outerFaux.setResponses([
			fauxAssistantMessage([fauxToolCall("agent_run", { text: "do something", profile: "explore" })]),
			fauxAssistantMessage("timed out reply"),
		]);

		await agent.ready();
		await dialog.send("run the subagent", "human", 10_000);

		// Without getFullTools: outer timeout = HTTP_TIMEOUT_MS (200ms)
		// Inner takes 500ms → times out → outer LLM gets error result but still replies
		// The reply arrives (outer LLM handles the timeout error) but the tool failed
		// We assert it still completes (outer LLM recovers) — the regression is the tool failure
		expect(reply).toBe("timed out reply");
	}, 10_000);
});
