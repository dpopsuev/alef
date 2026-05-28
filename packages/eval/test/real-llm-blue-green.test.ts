/**
 * ALE-TSK-351 — Real-LLM blue-green survival test.
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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { addTypeExport } from "../src/evaluations/write.js";
import { EvalHarness, EvaluationRunner } from "../src/index.js";
import { SKIP_REAL_LLM } from "../src/model.js";

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

describe.skipIf(SKIP_REAL_LLM)("Real-LLM blue-green survival", () => {
	it("file written by LLM survives supervisor blue-green swap", async () => {
		// ── Step 1: real LLM makes a minor code change ────────────────────────
		const harness = new EvalHarness();
		const runner = new EvaluationRunner(harness);
		const result = await runner.run({ ...addTypeExport, scenarioTimeoutMs: 120_000 });

		if (result.errors.length > 0) {
			throw new Error(
				`Eval step failed (not a blue-green bug): ${result.errors.join("; ")}\n` +
					`Score: ${result.score}  Error: ${result.metrics.error ?? "none"}`,
			);
		}
		expect(result.score).toBeGreaterThan(0);

		const workspace = result.metrics.workspace;
		if (!workspace) throw new Error("metrics.workspace must be set — EvaluationRunner must use keepWorkspace: true");

		// Confirm the LLM wrote the correct change before the swap.
		const typesPath = join(workspace, "src/types.ts");
		const contentBefore = readFileSync(typesPath, "utf-8");
		expect(contentBefore).toMatch(/export\s+interface\s+Session/);

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
				ALEF_GREEN_CWD: workspace,
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
		const contentAfter = readFileSync(typesPath, "utf-8");
		expect(contentAfter).toMatch(/export\s+interface\s+Session/);
		expect(contentAfter).toBe(contentBefore); // byte-for-byte identical
	}, 360_000); // eval (up to 180s) + supervisor boot + swap + buffer
});
