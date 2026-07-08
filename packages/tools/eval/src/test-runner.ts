import { execFile } from "node:child_process";
import { resolve } from "node:path";
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { defineAdapter, typedAction } from "@dpopsuev/alef-kernel/adapter";
import { withDisplay } from "@dpopsuev/alef-kernel/payload";
import { z } from "zod";

const DEFAULT_TIMEOUT_MS = 120_000;

/** A single test failure with name, file, and error message. */
export interface TestFailure {
	name: string;
	file: string;
	error: string;
}

/** Structured result from a vitest run. */
export interface TestRunResult {
	passed: number;
	failed: number;
	skipped: number;
	total: number;
	failures: TestFailure[];
	durationMs: number;
	exitCode: number;
}

/** Parse vitest JSON reporter output into a structured TestRunResult. */
export function parseVitestJson(raw: string, exitCode: number, durationMs: number): TestRunResult {
	try {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON.parse returns any; we validate fields below
		const data = JSON.parse(raw) as {
			numPassedTests?: number;
			numFailedTests?: number;
			numPendingTests?: number;
			numTotalTests?: number;
			testResults?: Array<{
				name?: string;
				assertionResults?: Array<{
					fullName?: string;
					status?: string;
					failureMessages?: string[];
				}>;
			}>;
		};

		const failures: TestFailure[] = [];
		for (const suite of data.testResults ?? []) {
			for (const test of suite.assertionResults ?? []) {
				if (test.status === "failed") {
					failures.push({
						name: test.fullName ?? "unknown",
						file: typeof suite.name === "string" ? suite.name : "unknown",
						error: (test.failureMessages ?? []).join("\n").slice(0, 500),
					});
				}
			}
		}

		return {
			passed: data.numPassedTests ?? 0,
			failed: data.numFailedTests ?? 0,
			skipped: data.numPendingTests ?? 0,
			total: data.numTotalTests ?? 0,
			failures,
			durationMs,
			exitCode,
		};
	} catch {
		return { passed: 0, failed: 0, skipped: 0, total: 0, failures: [], durationMs, exitCode };
	}
}

/** Run vitest on a package and return structured results. */
function runVitest(packagePath: string, timeoutMs: number, filePattern?: string): Promise<TestRunResult> {
	const root = resolve(import.meta.dirname, "../../../..");
	const args = ["vitest", "run", "--reporter=json", packagePath];
	if (filePattern) args.push(filePattern);

	const start = Date.now();
	return new Promise((res) => {
		const proc = execFile("npx", args, {
			cwd: root,
			timeout: timeoutMs,
			maxBuffer: 10 * 1024 * 1024,
			env: { ...process.env, NODE_OPTIONS: "" },
		}, (err, stdout, _stderr) => {
			const elapsed = Date.now() - start;
			const code = proc.exitCode ?? (err ? 1 : 0);
			const jsonStart = stdout.indexOf("{");
			const json = jsonStart >= 0 ? stdout.slice(jsonStart) : "";
			res(parseVitestJson(json, code, elapsed));
		});
	});
}

/** Create the test.run adapter — runs vitest and returns structured results. */
export function createTestRunnerAdapter(): Adapter {
	return defineAdapter(
		"test-runner",
		{
			command: {
				"test.run": typedAction(
					{
						name: "test.run",
						description:
							"Run the vitest test suite on a package and return structured results. " +
							"Returns { passed, failed, skipped, total, failures[], durationMs }. " +
							"Each failure includes test name, file, and error message.",
						inputSchema: z.object({
							package: z.string().min(1).describe("Package path relative to monorepo root, e.g. 'packages/core/agent/test'"),
							file: z.string().optional().describe("Optional file pattern to filter tests, e.g. 'signal-to-agent-event'"),
							timeoutMs: z.number().optional().describe("Timeout in ms (default 120000)"),
						}),
					},
					async (ctx) => {
						const pkg = typeof ctx.payload.package === "string" ? ctx.payload.package : "";
						const file = typeof ctx.payload.file === "string" ? ctx.payload.file : undefined;
						const timeout = typeof ctx.payload.timeoutMs === "number" ? ctx.payload.timeoutMs : DEFAULT_TIMEOUT_MS;

						const result = await runVitest(pkg, timeout, file);

						const summary = result.failed > 0
							? `${result.failed} FAILED, ${result.passed} passed (${result.total} total, ${result.durationMs}ms)`
							: `All ${result.passed} passed (${result.total} total, ${result.durationMs}ms)`;

						const failureText = result.failures
							.map((f) => `  ✗ ${f.name}\n    ${f.file}\n    ${f.error.split("\n")[0]}`)
							.join("\n\n");

						const display = failureText
							? `${summary}\n\n${failureText}`
							: summary;

						return withDisplay(result as unknown as Record<string, unknown>, { text: display, mimeType: "text/plain" }); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- TestRunResult is a plain data object safe to serialize
					},
				),
			},
		},
		{
			description: "Run vitest test suites and return structured results for self-reinforcement loops.",
			directives: [
				"Use test.run to execute tests after making code changes. Pass the package path and optionally a file pattern.",
			],
		},
	);
}
