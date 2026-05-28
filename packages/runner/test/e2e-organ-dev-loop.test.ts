/**
 * ALE-TSK-340 — Agentic organ dev loop: uses organ-supervisor + organ-eval AS organs.
 *
 * Replaces the previous test that manually reimplemented collectEvents,
 * postMessage, and runValidators by calling organ-eval internals directly.
 * Now the organs are mounted on an InProcessNerve and driven via Motor events,
 * validating that the composition works end-to-end.
 *
 * Flow:
 *   1. Write a simple echo organ to disk (simulates nodesh.eval output)
 *   2. Publish motor/supervisor.spawn → Sense returns { endpoint, name }
 *   3. Publish motor/eval.run with endpoint → Sense returns EvalResult
 *   4. Assert EvalResult.passed
 *   5. Publish motor/supervisor.kill to clean up
 *
 * No real LLM — ALEF_SCRIPTED_REPLIES drives the child's dialog.message.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createEvalOrgan } from "@dpopsuev/alef-organ-eval";
import { createSupervisorOrgan } from "@dpopsuev/alef-organ-supervisor";
import type { SenseEvent } from "@dpopsuev/alef-spine";
import { InProcessNerve } from "@dpopsuev/alef-spine";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const unmounts: Array<() => void> = [];

afterEach(() => {
	for (const u of unmounts.splice(0)) u();
	for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Temp dirs must be inside the monorepo root so jiti can resolve workspace
// packages (@dpopsuev/alef-spine etc.) by traversing up to node_modules.
const WORKSPACE_ROOT = resolve(__dirname, "../../..");

function makeTmp(): string {
	// Use workspace root as parent so jiti finds node_modules when loading organs.
	const d = mkdtempSync(join(WORKSPACE_ROOT, ".tmp-organ-loop-"));
	tempDirs.push(d);
	return d;
}

/** Publish a Motor event and wait for the matching Sense reply. */
function motorCall(
	nerve: InProcessNerve,
	toolName: string,
	payload: Record<string, unknown>,
	timeoutMs: number,
): Promise<SenseEvent> {
	return new Promise((resolve, reject) => {
		const correlationId = randomUUID();
		const timer = setTimeout(() => reject(new Error(`motor/${toolName} timed out after ${timeoutMs}ms`)), timeoutMs);
		const off = nerve.asNerve().sense.subscribe(toolName, (event) => {
			if (event.correlationId === correlationId) {
				clearTimeout(timer);
				off();
				resolve(event);
			}
		});
		nerve.asNerve().motor.publish({ type: toolName, correlationId, payload });
	});
}

describe("ALE-TSK-340: organ-dev-loop via supervisor + eval organs", () => {
	it("spawn child via supervisor.spawn, eval via eval.run, assert passes", async () => {
		// organ files live inside workspace so jiti resolves @dpopsuev/* packages.
		const organDir = makeTmp();
		const cwd = organDir; // child Alef cwd — workspace adjacent

		// ── Step 1: write echo organ to disk ─────────────────────────────
		// Simulates what the agent does via nodesh.eval in the real loop.
		const organPath = join(organDir, "echo-organ.ts");
		writeFileSync(
			organPath,
			`
import { defineOrgan } from "@dpopsuev/alef-spine";
import { z } from "zod";

export function createOrgan() {
  return defineOrgan("echo", {
    "motor/echo.ping": {
      tool: {
        name: "echo.ping",
        description: "Echo a message back as pong. Use to verify the organ is running.",
        inputSchema: z.object({ message: z.string() }),
      },
      handle: async (ctx) => ({ reply: \`pong:\${ctx.payload.message}\` }),
    },
  }, {
    description: "Simple echo organ for integration testing.",
    directives: ["Use echo.ping to verify the child agent is responsive."],
  });
}
			`.trim(),
			"utf-8",
		);

		// Scripted reply: the child inherits process.env, so this drives
		// the child's dialog.message without a real LLM call.
		const SCRIPTED_REPLY = "Echo organ loaded and responding.";
		process.env.ALEF_SCRIPTED_REPLIES = JSON.stringify([SCRIPTED_REPLY]);

		// ── Step 2: mount organs on a shared nerve ────────────────────────
		const nerve = new InProcessNerve();
		const supervisorOrgan = createSupervisorOrgan({ cwd });
		const evalOrgan = createEvalOrgan({});
		unmounts.push(supervisorOrgan.mount(nerve.asNerve()));
		unmounts.push(evalOrgan.mount(nerve.asNerve()));

		// ── Step 3: supervisor.spawn — start child Alef with echo organ ──
		const spawnResult = await motorCall(
			nerve,
			"supervisor.spawn",
			{
				organs: [organPath],
				cwd,
			},
			30_000,
		);

		expect(spawnResult.isError, spawnResult.errorMessage).toBe(false);
		const { endpoint, name } = spawnResult.payload as { endpoint: string; name: string };
		expect(endpoint).toMatch(/^http:\/\//);
		expect(name).toMatch(/^child-/);

		// ── Step 4: eval.run — drive child, validate response ────────────
		// ALEF_SCRIPTED_REPLIES is set on the child process via the supervisor.
		// The scripted reply simulates the child's dialog.message response.
		// The eval validates structurally: reply must contain "Echo organ".
		const evalResult = await motorCall(
			nerve,
			"eval.run",
			{
				endpoint,
				prompts: [{ role: "user", text: "ping please" }],
				validators: [{ type: "contains", value: "Echo" }],
			},
			20_000,
		);

		// eval.run may return isError=false but passed=false — check payload
		const result = evalResult.payload as {
			passed: boolean;
			score: number;
			failures: string[];
			reasoning: string;
		};

		// Restore env before cleanup
		delete process.env.ALEF_SCRIPTED_REPLIES;

		// ── Step 5: clean up via supervisor.kill ─────────────────────────
		await motorCall(nerve, "supervisor.kill", { name }, 5_000).catch(() => {
			/* ignore kill errors */
		});

		expect(result.passed, `failures: ${result.failures.join(", ")}`).toBe(true);
	}, 60_000);
});
