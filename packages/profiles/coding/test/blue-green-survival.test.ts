/**
 * Real-LLM blue-green survival test.
 *
 * Scenario:
 *   1. Real LLM agent makes a minor code change (addTypeExport eval).
 *   2. Supervisor performs a blue-green swap — new green inherits the same
 *      workspace directory via ALEF_GREEN_CWD env var.
 *   3. Assert the file written by the LLM in step 1 still exists and is
 *      correct after the swap.
 *
 * IPC flow:
 *   green script boots → reports ready → self-sends { type:"rebuild" }
 *   supervisor receives rebuild → spawnGreen(sessionId) → wait ready → promote → kill old
 *   test waits for "Promoted staging slot" in supervisor stderr
 *   test reads file from ALEF_GREEN_CWD workspace → asserts content unchanged
 *
 * Skipped when no LLM credentials are present (same gate as real-llm.test.ts).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentLoop } from "@dpopsuev/alef-reasoner";
import { afterEach, describe, expect, it } from "vitest";
import { addTypeExport } from "../../../core/eval/src/evaluations/write.js";
import { EvalHarness, EvaluationRunner } from "../../../core/eval/src/index.js";
import { getEvalModel, SKIP_REAL_LLM } from "../../../core/eval/src/model.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TSX = resolve(ROOT, "node_modules/tsx/dist/cli.mjs");
const RUNNER_MAIN = resolve(ROOT, "packages/runner/src/main.ts");
const SUPERVISOR = resolve(ROOT, "packages/runner/src/supervisor.ts");
const TSCONFIG = resolve(ROOT, "tsconfig.json");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const temps: string[] = [];
afterEach(() => {
	for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeTmp(): string {
	const d = mkdtempSync(join(tmpdir(), "alef-bg-test-"));
	temps.push(d);
	return d;
}

function waitForOutput(proc: ChildProcess, pattern: RegExp, timeoutMs: number): Promise<string> {
	return new Promise((res, rej) => {
		let buf = "";
		const onData = (chunk: Buffer) => {
			buf += chunk.toString();
			if (pattern.test(buf)) {
				clearTimeout(t);
				proc.stdout?.off("data", onData);
				proc.stderr?.off("data", onData);
				res(buf);
			}
		};
		const t = setTimeout(
			() => rej(new Error(`waitForOutput(${pattern}) timed out.\nOutput so far:\n${buf.slice(-1000)}`)),
			timeoutMs,
		);
		proc.stdout?.on("data", onData);
		proc.stderr?.on("data", onData);
		proc.once("exit", (code) => {
			clearTimeout(t);
			rej(new Error(`Process exited (${code}) before pattern matched.\nOutput:\n${buf.slice(-1000)}`));
		});
	});
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_REAL_LLM)(
	"blue-green survival: file written by LLM persists across supervisor swap",
	{ tags: ["real-llm"] },
	() => {
		it("file written by LLM survives supervisor blue-green swap", async () => {
			// ── Step 1: real LLM makes a minor code change ────────────────────────
			// EvaluationRunner deletes the workspace after the checker runs.
			// Wrap the checker to copy the workspace to a stable location before deletion,
			// and capture the file content we want to assert on.
			const stableWorkspace = makeTmp();
			let capturedContent = "";
			const wrappedEval = {
				...addTypeExport,
				scenarioTimeoutMs: 120_000,
				checker: {
					check: async (ctx: Parameters<typeof addTypeExport.checker.check>[0]) => {
						const r = await addTypeExport.checker.check(ctx);
						try {
							// Copy workspace to stable dir so supervisor can use it post-deletion.
							cpSync(ctx.workspace, stableWorkspace, { recursive: true });
							capturedContent = readFileSync(join(ctx.workspace, "src/types.ts"), "utf-8");
						} catch {}
						return r;
					},
				},
			};

			const harness = new EvalHarness();
			const runner = new EvaluationRunner(harness, {
				adapterFactory: (signal) => [createAgentLoop({ model: getEvalModel(), getSignal: () => signal })],
			});
			const result = await runner.run(wrappedEval);

			const workspace = result.metrics.workspace;
			if (!workspace) throw new Error("metrics.workspace must be set");

			if (result.errors.length > 0) {
				throw new Error(
					`Eval failed: ${result.errors.join("; ")}\n` +
						`Score: ${result.score}  Error: ${result.metrics.error ?? "none"}`,
				);
			}
			expect(result.score).toBeGreaterThan(0);

			// Guard: empty content means the agent wrote nothing — catch this clearly
			// rather than letting a confusing regex-mismatch be the error.
			if (!capturedContent) throw new Error("LLM wrote empty file — eval passed but agent produced no output");
			expect(capturedContent).toMatch(/export\s+interface\s+Session/);

			// ── Step 2: blue-green swap ──────────────────────────────────────────
			//
			// Green script: boots runner with --cwd ALEF_GREEN_CWD so both the
			// old and new green share the same workspace directory. After the
			// router binds its port, it self-sends { type:"rebuild" } to the
			// supervisor via IPC, which triggers doRebuild() → promotes a new
			// green → kills the old one.
			//
			// ALEF_GREEN_CWD is passed through supervisor's env → green's env
			// automatically (supervisor uses { ...process.env } when spawning).
			const tmpDir = makeTmp();
			const greenScript = join(tmpDir, "green.mjs");

			writeFileSync(
				greenScript,
				`
import { spawn } from "node:child_process";

const tsx = ${JSON.stringify(TSX)};
const main = ${JSON.stringify(RUNNER_MAIN)};
const tsconfig = ${JSON.stringify(TSCONFIG)};
const cwd = process.env.ALEF_GREEN_CWD || process.cwd();
const sessionArgs = process.env.ALEF_CURRENT_SESSION
	? ["--resume", process.env.ALEF_CURRENT_SESSION]
	: [];

const proc = spawn(process.execPath, [tsx, main, "--serve", "0", "--no-tui", "--cwd", cwd, ...sessionArgs], {
	cwd,
	stdio: ["inherit", "pipe", "pipe", "ipc"],
	// ALEF_SUPERVISOR=1 enables the handoff_prepare/ack handler in main.ts.
	env: { ...process.env, TSX_TSCONFIG_PATH: tsconfig, ALEF_SUPERVISOR: "1" },
});

proc.stdout.pipe(process.stdout);
proc.stderr.pipe(process.stderr);
process.on("message", (msg) => { if (proc.connected) proc.send(msg); });
proc.on("message", (msg) => { if (process.connected) process.send(msg); });
proc.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGTERM", () => { proc.kill("SIGTERM"); });

// Self-trigger blue-green once the router is ready.
// This simulates what an agent would do after writing code.
let triggered = false;
let buf = "";
proc.stderr.on("data", (chunk) => {
	buf += chunk.toString();
	if (!triggered && buf.includes("router listening on")) {
		triggered = true;
		if (typeof process.send === "function") {
			process.send({ type: "rebuild" });
		}
	}
});
`,
				"utf-8",
			);

			const supervisor = spawn(process.execPath, [TSX, SUPERVISOR], {
				cwd: tmpDir,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					ALEF_GREEN_CWD: stableWorkspace,
					ALEF_SUPERVISOR_GREEN_SCRIPT: greenScript,
					ALEF_SUPERVISOR_BUILD_COMMAND: `${process.execPath} -e "process.exit(0)"`,
					ALEF_SUPERVISOR_SKIP_HEALTH: "1",
					ALEF_SUPERVISOR_AUTO_REBUILD_ON_START: "0",
					TSX_TSCONFIG_PATH: TSCONFIG,
				},
			});

			try {
				// Wait for the green to boot and trigger rebuild, then for the
				// supervisor to complete the promotion.
				// Eval takes up to 3 min; supervisor swap adds ~10s. 90s for swap is generous.
				await waitForOutput(supervisor, /Promoted staging slot/, 90_000);
			} finally {
				supervisor.kill("SIGTERM");
			}

			// ── Step 3: assert file survived the swap ─────────────────────────────
			const typesPath = join(stableWorkspace, "src/types.ts");
			const contentAfter = readFileSync(typesPath, "utf-8");
			expect(contentAfter).toMatch(/export\s+interface\s+Session/);
			expect(contentAfter).toBe(capturedContent); // byte-for-byte identical
		}, 360_000); // eval (up to 180s) + supervisor boot + swap + buffer
	},
);
