/**
 * Agentic organ dev loop: uses organ-agent + organ-eval AS organs.
 *
 * Replaces the previous test that manually reimplemented collectEvents,
 * postMessage, and runValidators by calling organ-eval internals directly.
 * Now the organs are mounted on an InProcessNerve and driven via Motor events,
 * validating that the composition works end-to-end.
 *
 * Flow:
 * 1. Write a simple echo organ to disk (simulates nodesh.eval output)
 * 2. Publish motor/agent.spawn → Sense returns { endpoint, name }
 * 3. Publish motor/eval.run with endpoint → Sense returns EvalResult
 * 4. Assert EvalResult.passed
 * 5. Publish motor/agent.kill to clean up
 *
 * No real LLM — ALEF_SCRIPTED_REPLIES drives the child's llm.response.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SenseEvent } from "@dpopsuev/alef-kernel";
import { InProcessNerve } from "@dpopsuev/alef-kernel";
import { createAgentOrgan } from "@dpopsuev/alef-organ-agent";
import { createEvalOrgan } from "@dpopsuev/alef-organ-eval";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const unmounts: Array<() => void> = [];

afterEach(() => {
	for (const u of unmounts.splice(0)) u();
	for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeTmp(): string {
	// Now safe to use OS tmpdir — supervisor.spawn sets NODE_PATH so jiti
	// resolves @dpopsuev/* packages regardless of organ file location.
	const d = mkdtempSync(join(tmpdir(), "alef-organ-loop-"));
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

describe("organ dev loop via supervisor", { tags: ["e2e"] }, () => {
	it("spawn child via supervisor.spawn, eval via eval.run, assert passes", async () => {
		const organDir = makeTmp();
		const cwd = organDir;

		// ── Step 1: write echo organ to disk ─────────────────────────────
		// Simulates what the agent does via nodesh.eval in the real loop.
		const organPath = join(organDir, "echo-organ.ts");
		writeFileSync(
			organPath,
			`
import { defineOrgan } from "@dpopsuev/alef-kernel";
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
 description: "Simple echo organ for integration testing — replies pong to any message.",
 directives: ["Use echo.ping to verify the child agent is alive and processing requests correctly."],
 });
}
			`.trim(),
			"utf-8",
		);

		// Scripted reply: the child inherits process.env.
		const SCRIPTED_REPLY = "Echo organ loaded and responding.";
		process.env.ALEF_SCRIPTED_REPLIES = JSON.stringify([SCRIPTED_REPLY]);
		// Also set NODE_PATH directly in the test process env so the orchestration organ
		// inherits it — belt-and-suspenders with the fix in organ-agent.
		const alefNodeModules = join(resolve(__dirname, "../../.."), "node_modules");
		if (!process.env.NODE_PATH?.includes(alefNodeModules)) {
			process.env.NODE_PATH = [alefNodeModules, process.env.NODE_PATH].filter(Boolean).join(":");
		}

		// ── Step 2: mount organs on a shared nerve ────────────────────────
		const nerve = new InProcessNerve();
		const orchestrationOrgan = createAgentOrgan({ cwd, replyEvent: "llm.response" });
		const evalOrgan = createEvalOrgan({ replyEvent: "llm.response" });
		unmounts.push(orchestrationOrgan.mount(nerve.asNerve()));
		unmounts.push(evalOrgan.mount(nerve.asNerve()));

		// ── Step 3: agent.spawn — start child Alef with echo organ ──
		const spawnResult = await motorCall(
			nerve,
			"agent.spawn",
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
		// The scripted reply simulates the child's llm.response response.
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

		// ── Step 5: clean up via agent.kill ─────────────────────────
		await motorCall(nerve, "agent.kill", { name }, 5_000).catch(() => {
			/* ignore kill errors */
		});

		expect(result.passed, `failures: ${result.failures.join(", ")}`).toBe(true);
	}, 60_000);
});
