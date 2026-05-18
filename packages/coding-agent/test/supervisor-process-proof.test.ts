import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const supervisorPath = resolve(__dirname, "../src/supervisor.ts");
const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const tsconfigPath = resolve(__dirname, "../../../tsconfig.json");
const VALID_BUILD_HASH = "a".repeat(64);
const OTHER_BUILD_HASH = "b".repeat(64);

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("supervisor process proofs", () => {
	it("promotes staging slot after smoke pass", async () => {
		const fixture = createFixture();
		const harness = new SupervisorHarness({
			greenScriptPath: fixture.greenScriptPath,
			hashScriptPath: fixture.hashScriptPath,
			handoffPath: fixture.handoffPath,
			forcedEvalResult: "pass",
			autoRebuild: true,
		});
		try {
			await harness.start();
			await harness.waitForOutput(/FAKE_GREEN_STARTED/, 20_000);
			await harness.waitForOutput(/Promoted staging slot\./, 20_000);
			const starts = harness.output.match(/FAKE_GREEN_STARTED/g)?.length ?? 0;
			expect(starts).toBeGreaterThanOrEqual(1);
			if (existsSync(fixture.handoffPath)) {
				const handoff = JSON.parse(readFileSync(fixture.handoffPath, "utf-8")) as { phase?: string };
				expect(["prepared", "acked", "finalized"]).toContain(handoff.phase);
			}
		} finally {
			await harness.stop();
		}
	}, 60_000);

	it("rolls back to previous slot after smoke failure", async () => {
		const fixture = createFixture();
		const harness = new SupervisorHarness({
			greenScriptPath: fixture.greenScriptPath,
			hashScriptPath: fixture.hashScriptPath,
			handoffPath: fixture.handoffPath,
			forcedEvalResult: "fail",
			autoRebuild: true,
		});
		try {
			await harness.start();
			await harness.waitForOutput(/FAKE_GREEN_STARTED/, 20_000);
			await harness.waitForOutput(/Rolling back to previous active slot\./, 20_000);
			const starts = harness.output.match(/FAKE_GREEN_STARTED/g)?.length ?? 0;
			expect(starts).toBeGreaterThanOrEqual(1);
			expect(existsSync(fixture.handoffPath)).toBe(false);
		} finally {
			await harness.stop();
		}
	}, 60_000);

	it("resumes session from pending hand-off envelope on cold start", async () => {
		const fixture = createFixture();
		writeFileSync(
			fixture.handoffPath,
			JSON.stringify(
				{
					schemaVersion: "v1",
					updateId: "pending-upd-1",
					sourceSlot: "green",
					targetSlot: "blue",
					sessionFile: "/tmp/pending-session.jsonl",
					phase: "prepared",
					preparedAt: Date.now(),
				},
				null,
				2,
			),
			"utf-8",
		);

		const harness = new SupervisorHarness({
			greenScriptPath: fixture.greenScriptPath,
			hashScriptPath: fixture.hashScriptPath,
			handoffPath: fixture.handoffPath,
			forcedEvalResult: "pass",
			autoRebuild: false,
		});
		try {
			await harness.start();
			await harness.waitForOutput(/FAKE_GREEN_ARGS /, 20_000);
			const argsLine =
				harness.output
					.split("\n")
					.find((line) => line.startsWith("FAKE_GREEN_ARGS "))
					?.slice("FAKE_GREEN_ARGS ".length) ?? "[]";
			const parsedArgs = JSON.parse(argsLine) as string[];
			expect(parsedArgs).toContain("--session");
			expect(parsedArgs).toContain("/tmp/pending-session.jsonl");
		} finally {
			await harness.stop();
		}
	}, 40_000);

	it("simulates hashed tagged happy-path deploy and slot switch", async () => {
		const fixture = createFixture();
		const harness = new SupervisorHarness({
			greenScriptPath: fixture.greenScriptPath,
			hashScriptPath: fixture.hashScriptPath,
			handoffPath: fixture.handoffPath,
			forcedEvalResult: "pass",
			autoRebuild: false,
			autoUpdateScope: "packages",
			targetTag: "v0.0.1",
			expectedBuildHash: VALID_BUILD_HASH,
			buildHashOutput: VALID_BUILD_HASH,
		});
		try {
			await harness.start();
			await harness.waitForOutput(/Running packages pre-step\.\.\./, 20_000);
			await harness.waitForOutput(/Verified build hash [a-f0-9]{64} for tag v0\.0\.1\./, 20_000);
			await harness.waitForOutput(/Eval gate passed. Promoted staging slot./, 20_000);
			expect(harness.output).toContain("FSM accepted promote: staging_healthy -> promoted");
			expect(harness.output).toContain("FSM accepted retire_old: promoted -> idle");
		} finally {
			await harness.stop();
		}
	}, 60_000);

	it("simulates hashed deploy failure with explicit mismatch error output", async () => {
		const fixture = createFixture();
		const harness = new SupervisorHarness({
			greenScriptPath: fixture.greenScriptPath,
			hashScriptPath: fixture.hashScriptPath,
			handoffPath: fixture.handoffPath,
			forcedEvalResult: "pass",
			autoRebuild: false,
			autoUpdateScope: "packages",
			targetTag: "v0.0.1",
			expectedBuildHash: VALID_BUILD_HASH,
			buildHashOutput: OTHER_BUILD_HASH,
		});
		try {
			await harness.start();
			await harness.waitForOutput(/Build hash mismatch: expected/, 20_000);
			expect(harness.output).toContain("FSM accepted rollback: spawn_requested -> idle");
			expect(harness.output).not.toContain("Promoted staging slot.");
		} finally {
			await harness.stop();
		}
	}, 60_000);

	it("enforces that update and upgrade require tagged targets and sha256 hash policy", async () => {
		const fixture = createFixture();
		const updateHarness = new SupervisorHarness({
			greenScriptPath: fixture.greenScriptPath,
			hashScriptPath: fixture.hashScriptPath,
			handoffPath: fixture.handoffPath,
			forcedEvalResult: "pass",
			autoRebuild: false,
			autoUpdateScope: "packages",
			targetTag: "latest",
			expectedBuildHash: VALID_BUILD_HASH,
			buildHashOutput: VALID_BUILD_HASH,
		});

		try {
			await updateHarness.start();
			await updateHarness.waitForOutput(
				/Tagged packages flow requires ALEF_SUPERVISOR_TARGET_TAG with semver format/,
				20_000,
			);
			expect(updateHarness.output).not.toContain("Running packages pre-step...");
		} finally {
			await updateHarness.stop();
		}

		const upgradeHarness = new SupervisorHarness({
			greenScriptPath: fixture.greenScriptPath,
			hashScriptPath: fixture.hashScriptPath,
			handoffPath: fixture.handoffPath,
			forcedEvalResult: "pass",
			autoRebuild: false,
			autoUpdateScope: "self",
			targetTag: "v0.0.2",
			expectedBuildHash: "not-a-sha256",
			buildHashOutput: VALID_BUILD_HASH,
		});

		try {
			await upgradeHarness.start();
			await upgradeHarness.waitForOutput(
				/Tagged self flow requires ALEF_SUPERVISOR_EXPECTED_BUILD_HASH with a SHA-256 hex digest\./,
				20_000,
			);
			expect(upgradeHarness.output).not.toContain("Running self pre-step...");
		} finally {
			await upgradeHarness.stop();
		}

		const optOutHarness = new SupervisorHarness({
			greenScriptPath: fixture.greenScriptPath,
			hashScriptPath: fixture.hashScriptPath,
			handoffPath: fixture.handoffPath,
			forcedEvalResult: "pass",
			autoRebuild: false,
			autoUpdateScope: "packages",
			allowUnverifiedUpdates: true,
		});

		try {
			await optOutHarness.start();
			await optOutHarness.waitForOutput(
				/Security policy opt-out active via ALEF_SUPERVISOR_ALLOW_UNVERIFIED_UPDATES=1/,
				20_000,
			);
			await optOutHarness.waitForOutput(/Eval gate passed. Promoted staging slot./, 20_000);
		} finally {
			await optOutHarness.stop();
		}
	}, 60_000);

	it("passes eval gate failure report to new green via env var", async () => {
		const fixture = createFixture();
		const harness = new SupervisorHarness({
			greenScriptPath: fixture.greenScriptPath,
			hashScriptPath: fixture.hashScriptPath,
			handoffPath: fixture.handoffPath,
			forcedEvalResult: "fail",
			autoRebuild: true,
		});
		try {
			await harness.start();
			// First green starts, rebuild is triggered, eval gate fails, second green spawned.
			await harness.waitForOutput(/Rolling back to previous active slot\./, 30_000);
			// Second green receives the report env var.
			await harness.waitForOutput(/FAKE_GREEN_EVAL_REPORT/, 20_000);
			expect(harness.output).toContain("FAKE_GREEN_EVAL_REPORT forced fail");
		} finally {
			await harness.stop();
		}
	}, 60_000);

	it("does not set eval gate report env var when probe passes", async () => {
		const fixture = createFixture();
		const harness = new SupervisorHarness({
			greenScriptPath: fixture.greenScriptPath,
			hashScriptPath: fixture.hashScriptPath,
			handoffPath: fixture.handoffPath,
			forcedEvalResult: "pass",
			autoRebuild: true,
		});
		try {
			await harness.start();
			await harness.waitForOutput(/Eval gate passed\. Promoted staging slot\./, 30_000);
			// Green after successful promotion must NOT receive an error report.
			await harness.waitForOutput(/FAKE_GREEN_NO_EVAL_REPORT/, 20_000);
			expect(harness.output).not.toContain("FAKE_GREEN_EVAL_REPORT ");
		} finally {
			await harness.stop();
		}
	}, 60_000);

	it("rolls back when health check fails before eval gate", async () => {
		const fixture = createFixture();
		const harness = new SupervisorHarness({
			greenScriptPath: fixture.greenScriptPath,
			hashScriptPath: fixture.hashScriptPath,
			handoffPath: fixture.handoffPath,
			forcedEvalResult: "pass",
			forcedHealthResult: "fail",
			skipHealth: false,
			autoRebuild: true,
		});
		try {
			await harness.start();
			await harness.waitForOutput(/Health check failed: forced fail/, 30_000);
			// Eval gate must NOT run after a failed health check.
			expect(harness.output).not.toContain("Running blue-slot eval gate");
			// Rollback is triggered.
			expect(harness.output).toContain("FSM accepted rollback");
		} finally {
			await harness.stop();
		}
	}, 60_000);

	it("proceeds to eval gate when health check passes", async () => {
		const fixture = createFixture();
		const harness = new SupervisorHarness({
			greenScriptPath: fixture.greenScriptPath,
			hashScriptPath: fixture.hashScriptPath,
			handoffPath: fixture.handoffPath,
			forcedEvalResult: "pass",
			forcedHealthResult: "pass",
			skipHealth: false,
			autoRebuild: true,
		});
		try {
			await harness.start();
			await harness.waitForOutput(/Health check passed\./, 30_000);
			await harness.waitForOutput(/Running blue-slot eval gate/, 10_000);
			await harness.waitForOutput(/Eval gate passed\. Promoted staging slot\./, 30_000);
		} finally {
			await harness.stop();
		}
	}, 60_000);
});

// ---------------------------------------------------------------------------
// verify-and-reexec proof tests (TSK-27 / TSK-28)
// ---------------------------------------------------------------------------

describe("supervisor verify-and-reexec (scope=self)", () => {
	it("probes itself, tears down green, and re-execs new supervisor binary on pass", async () => {
		const fixture = createFixture();
		const harness = new SupervisorHarness({
			greenScriptPath: fixture.greenScriptPath,
			hashScriptPath: fixture.hashScriptPath,
			handoffPath: fixture.handoffPath,
			forcedEvalResult: "pass",
			autoRebuild: false,
			autoUpdateScope: "self",
			allowUnverifiedUpdates: true, // skip tag/hash policy for test
		});
		try {
			await harness.start();
			// Supervisor runs the probe against itself (--probe flag).
			await harness.waitForOutput(/Running verify-and-reexec probe/, 20_000);
			// Probe passes → supervisor tears down and execs new binary.
			await harness.waitForOutput(/Probe passed\. Tearing down and re-executing supervisor\./, 20_000);
			// New supervisor spawns a fresh green.
			await harness.waitForOutput(/FAKE_GREEN_STARTED/, 25_000);
		} finally {
			await harness.stop();
		}
	}, 75_000);

	it("falls back to rebuild lane when probe fails", async () => {
		const fixture = createFixture();
		const harness = new SupervisorHarness({
			greenScriptPath: fixture.greenScriptPath,
			hashScriptPath: fixture.hashScriptPath,
			handoffPath: fixture.handoffPath,
			forcedEvalResult: "fail", // probe fails
			autoRebuild: false,
			autoUpdateScope: "self",
			allowUnverifiedUpdates: true,
		});
		try {
			await harness.start();
			// Probe is attempted.
			await harness.waitForOutput(/Running verify-and-reexec probe/, 20_000);
			// Probe fails — supervisor falls back to rebuild lane.
			await harness.waitForOutput(
				/Reexec verification failed|verify failed|rebuild lane|child verify failed/,
				20_000,
			);
			// Green still starts (rebuild or fresh start).
			await harness.waitForOutput(/FAKE_GREEN_STARTED/, 25_000);
		} finally {
			await harness.stop();
		}
	}, 75_000);
});

function createFixture(): { root: string; greenScriptPath: string; hashScriptPath: string; handoffPath: string } {
	const root = mkdtempSync(join(tmpdir(), "alef-supervisor-proof-"));
	tempDirs.push(root);
	const greenScriptPath = join(root, "fake-green.js");
	const hashScriptPath = join(root, "fake-hash.js");
	const handoffPath = join(root, "handoff.json");
	writeFileSync(
		greenScriptPath,
		`process.stdout.write("FAKE_GREEN_STARTED\\n");
process.stdout.write("FAKE_GREEN_ARGS " + JSON.stringify(process.argv.slice(2)) + "\\n");
const evalReport = process.env.ALEF_SUPERVISOR_EVAL_GATE_REPORT;
if (evalReport) {
  process.stdout.write("FAKE_GREEN_EVAL_REPORT " + evalReport.slice(0, 200) + "\\n");
} else {
  process.stdout.write("FAKE_GREEN_NO_EVAL_REPORT\\n");
}
process.on("message", (msg) => {
  if (msg && typeof msg === "object" && msg.type === "handoff_prepare" && msg.envelope && msg.envelope.updateId) {
    if (typeof process.send === "function") {
      process.send({ type: "handoff_ack", updateId: msg.envelope.updateId });
    }
  }
});
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
		"utf-8",
	);
	writeFileSync(
		hashScriptPath,
		`process.stdout.write(process.env.ALEF_SUPERVISOR_TEST_BUILD_HASH_OUTPUT ?? "");
`,
		"utf-8",
	);
	return { root, greenScriptPath, hashScriptPath, handoffPath };
}

class SupervisorHarness {
	private process: ChildProcess | undefined;
	private stdout = "";
	private stderr = "";

	// ── Instrumentation ──────────────────────────────────────────────────────
	private _spawnedAt: number | undefined;
	private _firstOutputAt: number | undefined;
	private _exitCode: number | null | undefined; // undefined = still running
	private _exitSignal: string | null | undefined;
	private _exitedAt: number | undefined;
	private _spawnError: Error | undefined;

	/** True if the process exited before the test finished. */
	get processExited(): boolean {
		return this._exitCode !== undefined || this._exitedAt !== undefined;
	}

	/** Diagnostic snapshot for postmortem in waitForOutput error messages. */
	get diagnostics(): string {
		const lines: string[] = [];
		if (this._spawnedAt !== undefined) {
			lines.push(`  spawnedAt:      ${new Date(this._spawnedAt).toISOString()}`);
		}
		if (this._firstOutputAt !== undefined) {
			const lag = this._firstOutputAt - (this._spawnedAt ?? this._firstOutputAt);
			lines.push(`  firstOutputAt:  ${new Date(this._firstOutputAt).toISOString()} (+${lag}ms after spawn)`);
		} else {
			lines.push(`  firstOutputAt:  (no output received)`);
		}
		if (this._exitedAt !== undefined) {
			lines.push(`  exitedAt:       ${new Date(this._exitedAt).toISOString()}`);
			lines.push(`  exitCode:       ${this._exitCode ?? "(none)"}`);
			lines.push(`  exitSignal:     ${this._exitSignal ?? "(none)"}`);
		} else {
			lines.push(`  process:        still running`);
		}
		if (this._spawnError) {
			lines.push(`  spawnError:     ${this._spawnError.message}`);
		}
		return lines.join("\n");
	}

	constructor(
		private readonly options: {
			greenScriptPath: string;
			hashScriptPath: string;
			handoffPath: string;
			forcedEvalResult: "pass" | "fail";
			autoRebuild: boolean;
			autoUpdateScope?: "rebuild" | "packages" | "self";
			allowUnverifiedUpdates?: boolean;
			targetTag?: string;
			expectedBuildHash?: string;
			buildHashOutput?: string;
			/** Force health check result without spawning the runner. Default: skip. */
			forcedHealthResult?: "pass" | "fail";
			/** Set to false to disable the default SKIP_HEALTH=1 override. */
			skipHealth?: boolean;
		},
	) {}

	get output(): string {
		return `${this.stdout}\n${this.stderr}`;
	}

	async start(): Promise<void> {
		if (this.process) {
			throw new Error("Supervisor harness already started.");
		}
		const autoUpdateScope = this.options.autoUpdateScope ?? (this.options.autoRebuild ? "rebuild" : undefined);
		const env: NodeJS.ProcessEnv = {
			...process.env,
			ALEF_SUPERVISOR_GREEN_SCRIPT: this.options.greenScriptPath,
			ALEF_SUPERVISOR_BUILD_COMMAND: 'node -e "process.exit(0)"',
			ALEF_SUPERVISOR_PACKAGE_UPDATE_COMMAND: 'node -e "process.exit(0)"',
			// Default: skip health check so tests don't spawn a real runner binary.
			ALEF_SUPERVISOR_SKIP_HEALTH: this.options.skipHealth === false ? undefined : "1",
			...(this.options.forcedHealthResult
				? { ALEF_SUPERVISOR_TEST_HEALTH_RESULT: this.options.forcedHealthResult }
				: {}),
			ALEF_SUPERVISOR_BUILD_HASH_COMMAND: `node ${JSON.stringify(this.options.hashScriptPath)}`,
			ALEF_SUPERVISOR_TEST_BUILD_HASH_OUTPUT: this.options.buildHashOutput ?? "",
			ALEF_SUPERVISOR_TEST_EVAL_RESULT: this.options.forcedEvalResult,
			ALEF_SUPERVISOR_HANDOFF_PATH: this.options.handoffPath,
			ALEF_SUPERVISOR_AUTO_REBUILD_ON_START: autoUpdateScope ? "0" : this.options.autoRebuild ? "1" : "0",
			TSX_TSCONFIG_PATH: tsconfigPath,
		};
		if (autoUpdateScope) {
			env.ALEF_SUPERVISOR_AUTO_UPDATE_SCOPE = autoUpdateScope;
		}
		if (this.options.allowUnverifiedUpdates) {
			env.ALEF_SUPERVISOR_ALLOW_UNVERIFIED_UPDATES = "1";
		}
		if (this.options.targetTag) {
			env.ALEF_SUPERVISOR_TARGET_TAG = this.options.targetTag;
		}
		if (this.options.expectedBuildHash) {
			env.ALEF_SUPERVISOR_EXPECTED_BUILD_HASH = this.options.expectedBuildHash;
		}
		this._spawnedAt = Date.now();
		this._exitCode = undefined;
		this._exitedAt = undefined;
		this._spawnError = undefined;
		this._firstOutputAt = undefined;

		this.process = spawn(process.execPath, [tsxPath, supervisorPath, "--no-session"], {
			cwd: resolve(__dirname, "../../.."),
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		this.process.on("error", (err) => {
			this._spawnError = err;
		});

		this.process.on("exit", (code, signal) => {
			this._exitCode = code;
			this._exitSignal = signal;
			this._exitedAt = Date.now();
		});

		this.process.stdout?.on("data", (chunk: Buffer | string) => {
			if (this._firstOutputAt === undefined) this._firstOutputAt = Date.now();
			this.stdout += chunk.toString();
		});
		this.process.stderr?.on("data", (chunk: Buffer | string) => {
			if (this._firstOutputAt === undefined) this._firstOutputAt = Date.now();
			this.stderr += chunk.toString();
		});
	}

	async stop(): Promise<void> {
		const proc = this.process;
		if (!proc) {
			return;
		}
		this.process = undefined;
		if (!proc.killed) {
			proc.kill("SIGTERM");
		}
		await new Promise<void>((resolvePromise) => {
			const timeout = setTimeout(() => {
				proc.kill("SIGKILL");
				resolvePromise();
			}, 2000);
			proc.once("close", () => {
				clearTimeout(timeout);
				resolvePromise();
			});
		});
	}

	async waitForOutput(pattern: RegExp, timeoutMs: number): Promise<void> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			if (pattern.test(this.output)) {
				return;
			}
			// Short-circuit: if process already exited, it will never produce more output
			if (this.processExited) {
				const elapsed = Date.now() - start;
				throw new Error(
					`Process exited (code=${this._exitCode}, signal=${this._exitSignal}) before pattern ${pattern} appeared.\n` +
						`Elapsed: ${elapsed}ms\nDiagnostics:\n${this.diagnostics}\nOutput:\n${this.output.slice(0, 2000)}`,
				);
			}
			await sleep(50);
		}
		const elapsed = Date.now() - start;
		throw new Error(
			`Timed out after ${elapsed}ms waiting for pattern ${pattern}.\n` +
				`Diagnostics:\n${this.diagnostics}\nOutput (last 2000 chars):\n${this.output.slice(-2000)}`,
		);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
