/**
 * Crash-safe handoff resume tests — RED then GREEN (TSK-183).
 *
 * The supervisor loads a handoff envelope on cold start. Currently it only
 * extracts the sessionFile. It should also complete the promotion based on
 * envelope phase — modelled on hegemony's resume_pending_handoff().
 *
 * Four cases:
 *
 *   prepared  → re-probe canary; if pass: promote + spawn green with finalize
 *               if fail: rollback + spawn fresh green
 *   acked     → canary was healthy, old slot not yet killed; skip health check,
 *               complete finalization, spawn green
 *   finalized → stale file; delete it, start normally
 *
 * All tests are deterministic: no real build, no real LLM, forced outcomes.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const supervisorPath = pathResolve(__dirname, "../src/supervisor.ts");
const tsxPath = pathResolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const tsconfigPath = pathResolve(__dirname, "../../../tsconfig.json");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createFixture(): {
	root: string;
	greenScriptPath: string;
	hashScriptPath: string;
	handoffPath: string;
} {
	const root = mkdtempSync(join(tmpdir(), "alef-handoff-resume-"));
	tempDirs.push(root);

	const greenScriptPath = join(root, "fake-green.js");
	writeFileSync(
		greenScriptPath,
		`process.stdout.write("FAKE_GREEN_STARTED\\n");
process.stdout.write("FAKE_GREEN_ARGS " + JSON.stringify(process.argv.slice(2)) + "\\n");
process.on("message", (msg) => {
  if (msg && typeof msg === "object" && msg.type === "handoff_prepare" && msg.envelope && msg.envelope.updateId) {
    if (typeof process.send === "function") {
      process.send({ type: "handoff_ack", updateId: msg.envelope.updateId });
    }
  }
  if (msg && typeof msg === "object" && msg.type === "handoff_finalize") {
    process.stdout.write("FAKE_GREEN_GOT_HANDOFF_FINALIZE\\n");
  }
});
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
		"utf-8",
	);

	const hashScriptPath = join(root, "fake-hash.js");
	writeFileSync(
		hashScriptPath,
		`process.stdout.write(process.env.ALEF_SUPERVISOR_TEST_BUILD_HASH_OUTPUT ?? "");
`,
		"utf-8",
	);

	const handoffPath = join(root, "handoff.json");

	return { root, greenScriptPath, hashScriptPath, handoffPath };
}

/** Write a handoff envelope at a specific phase to the handoff file. */
function writeHandoff(
	path: string,
	opts: {
		phase: "prepared" | "acked" | "finalized";
		updateId?: string;
		sourceSlot?: "green" | "blue";
		targetSlot?: "green" | "blue";
		sessionFile?: string;
	},
): void {
	const now = Date.now();
	const envelope = {
		schemaVersion: "v1",
		updateId: opts.updateId ?? "resume-test-upd",
		sourceSlot: opts.sourceSlot ?? "green",
		targetSlot: opts.targetSlot ?? "blue",
		sessionFile: opts.sessionFile,
		phase: opts.phase,
		preparedAt: now - 5000,
		...(opts.phase !== "prepared" ? { ackedAt: now - 2000 } : {}),
		...(opts.phase === "finalized" ? { finalizedAt: now - 1000 } : {}),
	};
	writeFileSync(path, JSON.stringify(envelope, null, 2), "utf-8");
}

/** Spawn supervisor and collect output until pattern matches or timeout. */
function runSupervisor(opts: {
	greenScriptPath: string;
	hashScriptPath: string;
	handoffPath: string;
	forcedHealthResult?: "pass" | "fail";
	skipHealth?: boolean;
}): Promise<{ output: string; exitCode: number | null }> {
	return new Promise((resolve) => {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			ALEF_SUPERVISOR_GREEN_SCRIPT: opts.greenScriptPath,
			ALEF_SUPERVISOR_BUILD_COMMAND: `${process.execPath} -e "process.exit(0)"`,
			ALEF_SUPERVISOR_PACKAGE_UPDATE_COMMAND: `${process.execPath} -e "process.exit(0)"`,
			ALEF_SUPERVISOR_BUILD_HASH_COMMAND: `node ${JSON.stringify(opts.hashScriptPath)}`,
			ALEF_SUPERVISOR_TEST_BUILD_HASH_OUTPUT: "",
			ALEF_SUPERVISOR_TEST_EVAL_RESULT: "pass",
			ALEF_SUPERVISOR_HANDOFF_PATH: opts.handoffPath,
			ALEF_SUPERVISOR_AUTO_REBUILD_ON_START: "0",
			TSX_TSCONFIG_PATH: tsconfigPath,
		};

		if (opts.forcedHealthResult) {
			env.ALEF_SUPERVISOR_TEST_HEALTH_RESULT = opts.forcedHealthResult;
		} else if (opts.skipHealth !== false) {
			env.ALEF_SUPERVISOR_SKIP_HEALTH = "1";
		}

		const proc = spawn(process.execPath, [tsxPath, supervisorPath, "--no-session"], {
			cwd: pathResolve(__dirname, "../../.."),
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		let output = "";
		proc.stdout?.on("data", (c: Buffer) => {
			output += c.toString();
		});
		proc.stderr?.on("data", (c: Buffer) => {
			output += c.toString();
		});

		// Kill after 15s to keep tests fast.
		const killTimer = setTimeout(() => proc.kill("SIGTERM"), 15_000);

		proc.on("exit", (code) => {
			clearTimeout(killTimer);
			resolve({ output, exitCode: code });
		});

		// Kill once we've seen enough output to assert.
		const checkInterval = setInterval(() => {
			const done =
				output.includes("FAKE_GREEN_STARTED") ||
				output.includes("rolling back") ||
				output.includes("Rolling back") ||
				output.includes("resume: handoff") ||
				output.includes("crash-recovery") ||
				output.includes("stale finalized");
			if (done) {
				clearInterval(checkInterval);
				setTimeout(() => proc.kill("SIGTERM"), 300);
			}
		}, 50);

		proc.on("exit", () => clearInterval(checkInterval));
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Supervisor handoff resume — prepared phase", () => {
	it("re-probes canary and completes promotion when health passes", async () => {
		const fixture = createFixture();
		writeHandoff(fixture.handoffPath, { phase: "prepared" });

		const { output } = await runSupervisor({
			greenScriptPath: fixture.greenScriptPath,
			hashScriptPath: fixture.hashScriptPath,
			handoffPath: fixture.handoffPath,
			forcedHealthResult: "pass",
		});

		// Supervisor should detect the prepared envelope, re-probe, and promote.
		expect(output).toMatch(/crash.?recovery|resume.*handoff|prepared.*envelope/i);
		expect(output).toMatch(/promot|healthy/i);
		// Handoff file should be cleared after promotion.
		expect(existsSync(fixture.handoffPath)).toBe(false);
		// Green should start.
		expect(output).toContain("FAKE_GREEN_STARTED");
	}, 30_000);

	it("rolls back and clears envelope when health fails", async () => {
		const fixture = createFixture();
		writeHandoff(fixture.handoffPath, { phase: "prepared" });

		const { output } = await runSupervisor({
			greenScriptPath: fixture.greenScriptPath,
			hashScriptPath: fixture.hashScriptPath,
			handoffPath: fixture.handoffPath,
			forcedHealthResult: "fail",
		});

		// Supervisor should detect the prepared envelope, re-probe, and rollback.
		expect(output).toMatch(/crash.?recovery|resume.*handoff|prepared.*envelope/i);
		expect(output).toMatch(/rollback|rolling back|unhealthy/i);
		// Handoff file should be cleared after rollback.
		expect(existsSync(fixture.handoffPath)).toBe(false);
		// Fresh green should still start.
		expect(output).toContain("FAKE_GREEN_STARTED");
	}, 30_000);
});

describe("Supervisor handoff resume — acked phase", () => {
	it("skips health check and completes finalization", async () => {
		const fixture = createFixture();
		writeHandoff(fixture.handoffPath, { phase: "acked" });

		const { output } = await runSupervisor({
			greenScriptPath: fixture.greenScriptPath,
			hashScriptPath: fixture.hashScriptPath,
			handoffPath: fixture.handoffPath,
			skipHealth: true,
		});

		// Supervisor should detect acked envelope and complete finalization.
		expect(output).toMatch(/crash.?recovery|resume.*handoff|acked.*envelope/i);
		expect(output).toMatch(/finaliz/i);
		// Handoff file should be cleared.
		expect(existsSync(fixture.handoffPath)).toBe(false);
		// Green should receive handoff_finalize and start.
		expect(output).toContain("FAKE_GREEN_STARTED");
	}, 30_000);
});

describe("Supervisor handoff resume — finalized phase", () => {
	it("deletes stale file and starts normally", async () => {
		const fixture = createFixture();
		writeHandoff(fixture.handoffPath, { phase: "finalized" });

		const { output } = await runSupervisor({
			greenScriptPath: fixture.greenScriptPath,
			hashScriptPath: fixture.hashScriptPath,
			handoffPath: fixture.handoffPath,
			skipHealth: true,
		});

		// Supervisor should detect finalized envelope and just clear it.
		expect(output).toMatch(/stale.*finalized|finalized.*cleared|clearing.*finalized/i);
		// Handoff file should be cleared.
		expect(existsSync(fixture.handoffPath)).toBe(false);
		// Green should start normally.
		expect(output).toContain("FAKE_GREEN_STARTED");
	}, 30_000);
});

describe("Supervisor handoff resume — session file preservation", () => {
	it("restores session file from prepared envelope on cold start", async () => {
		const fixture = createFixture();
		const sessionFile = join(fixture.root, "session.jsonl");
		writeHandoff(fixture.handoffPath, {
			phase: "prepared",
			sessionFile,
		});

		const { output } = await runSupervisor({
			greenScriptPath: fixture.greenScriptPath,
			hashScriptPath: fixture.hashScriptPath,
			handoffPath: fixture.handoffPath,
			forcedHealthResult: "pass",
		});

		// Green should be started with --session pointing to the session file.
		const argsLine = output
			.split("\n")
			.find((l) => l.startsWith("FAKE_GREEN_ARGS"))
			?.slice("FAKE_GREEN_ARGS ".length);
		if (argsLine) {
			const parsedArgs = JSON.parse(argsLine) as string[];
			expect(parsedArgs).toContain("--session");
			expect(parsedArgs).toContain(sessionFile);
		}
	}, 30_000);
});
