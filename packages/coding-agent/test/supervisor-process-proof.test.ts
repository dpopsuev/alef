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
			forcedSmokeResult: "pass",
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
			forcedSmokeResult: "fail",
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
			forcedSmokeResult: "pass",
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
			forcedSmokeResult: "pass",
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
			await harness.waitForOutput(/Smoke tests passed\. Promoted staging slot\./, 20_000);
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
			forcedSmokeResult: "pass",
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
			forcedSmokeResult: "pass",
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
			forcedSmokeResult: "pass",
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
			forcedSmokeResult: "pass",
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
			await optOutHarness.waitForOutput(/Smoke tests passed\. Promoted staging slot\./, 20_000);
		} finally {
			await optOutHarness.stop();
		}
	}, 60_000);
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
			forcedSmokeResult: "pass" | "fail";
			autoRebuild: boolean;
			autoUpdateScope?: "rebuild" | "packages" | "self";
			allowUnverifiedUpdates?: boolean;
			targetTag?: string;
			expectedBuildHash?: string;
			buildHashOutput?: string;
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
			ALEF_SUPERVISOR_BUILD_HASH_COMMAND: `node ${JSON.stringify(this.options.hashScriptPath)}`,
			ALEF_SUPERVISOR_TEST_BUILD_HASH_OUTPUT: this.options.buildHashOutput ?? "",
			ALEF_SUPERVISOR_TEST_SMOKE_RESULT: this.options.forcedSmokeResult,
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
