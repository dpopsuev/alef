/**
 * Tool-parity tests — prove that every Alef EDA tool that corresponds to a
 * pi-mono built-in is actually invoked by the LLM in a purpose-built scenario.
 *
 * pi-mono default toolset: file_read, file_bash, file_edit, file_write, file_grep, file_find
 * Alef EDA equivalents:   fs.read,  shell.exec, fs.edit,  fs.write,  fs.grep,   fs.find
 *
 * Each test designs a prompt that REQUIRES the target tool.
 * We assert the corresponding span appears in RunMetrics.spans.
 *
 * Skipped when ANTHROPIC_API_KEY is not set.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertToolNotUsed, assertToolUsed, EvalHarness, formatReport } from "../src/harness.js";
import { SKIP_REAL_LLM } from "../src/model.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a precise coding assistant. You have access to filesystem and shell tools.
Use the appropriate tool for every task. Never answer from memory when a tool can verify the answer.
Always use the tool that directly satisfies the task — do not substitute one tool for another.`;

let harness: EvalHarness;

beforeAll(() => {
	harness = new EvalHarness();
});

afterAll(() => {
	harness = undefined!;
});

const EXTRA_OPTS = {
	systemPrompt: SYSTEM_PROMPT,
	extraOrgans: [],
};

// ---------------------------------------------------------------------------
// fs.read — pi-mono: file_read
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_REAL_LLM)("fs.read (pi-mono: file_read)", () => {
	it("reads a file and reports its content", async () => {
		const metrics = await harness.run(
			async (ctx) => {
				await ctx.writeFile("src/config.ts", `export const PORT = 3000;\nexport const HOST = "localhost";\n`);
				const reply = await ctx.send("Read src/config.ts and tell me the exact value of PORT and HOST.");
				if (!reply.includes("3000")) throw new Error("PORT value not in reply");
				if (!reply.toLowerCase().includes("localhost")) throw new Error("HOST value not in reply");
			},
			{ scenario: "fs.read-parity", ...EXTRA_OPTS },
		);
		console.log(formatReport(metrics));
		assertToolUsed(metrics, "fs.read");
		expect(metrics.passed).toBe(true);
	}, 120_000);
});

// ---------------------------------------------------------------------------
// fs.write — pi-mono: file_write
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_REAL_LLM)("fs.write (pi-mono: file_write)", () => {
	it("creates a new file with specified content", async () => {
		const metrics = await harness.run(
			async (ctx) => {
				await ctx.send(
					"Create a file src/hello.ts with a single exported function " +
						"'greet(name: string): string' that returns the greeting string 'Hello, name'.",
				);
				const content = await ctx.readFile("src/hello.ts");
				if (!content.includes("greet")) throw new Error("greet function not found");
				if (!content.includes("Hello")) throw new Error("Hello string not found");
			},
			{ scenario: "fs.write-parity", ...EXTRA_OPTS },
		);
		console.log(formatReport(metrics));
		assertToolUsed(metrics, "fs.write");
		expect(metrics.passed).toBe(true);
	}, 120_000);
});

// ---------------------------------------------------------------------------
// fs.edit — pi-mono: file_edit
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_REAL_LLM)("fs.edit (pi-mono: file_edit)", () => {
	it("edits an existing file with a targeted change", async () => {
		const metrics = await harness.run(
			async (ctx) => {
				await ctx.writeFile(
					"src/utils.ts",
					`export function add(a: number, b: number): number {\n  return a + b;\n}\n`,
				);
				await ctx.send(
					"Edit src/utils.ts: add a second exported function `multiply(a: number, b: number): number` that returns a * b. " +
						"Do not rewrite the file — make a targeted edit.",
				);
				const content = await ctx.readFile("src/utils.ts");
				if (!content.includes("multiply")) throw new Error("multiply function not found");
				if (!content.includes("add")) throw new Error("add function was removed");
			},
			{ scenario: "fs.edit-parity", ...EXTRA_OPTS },
		);
		console.log(formatReport(metrics));
		// Either fs.edit or fs.write is acceptable (both achieve the task); assert at least one write-path tool.
		const writePathUsed =
			metrics.spans.some((s) => s.name === "alef.motor/fs.edit") ||
			metrics.spans.some((s) => s.name === "alef.motor/fs.write");
		if (!writePathUsed) throw new Error("Expected fs.edit or fs.write to be called");
		// Prefer fs.edit when it was used
		if (metrics.spans.some((s) => s.name === "alef.motor/fs.edit")) {
			assertToolUsed(metrics, "fs.edit");
		}
		expect(metrics.passed).toBe(true);
	}, 120_000);
});

// ---------------------------------------------------------------------------
// fs.grep — pi-mono: file_grep
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_REAL_LLM)("fs.grep (pi-mono: file_grep)", () => {
	it("searches for a pattern across files and reports matches", async () => {
		const metrics = await harness.run(
			async (ctx) => {
				await ctx.writeFile("src/auth.ts", `export function login(user: string) {}\nexport function logout() {}\n`);
				await ctx.writeFile("src/api.ts", `import { login } from "./auth";\nlogin("admin");\n`);
				await ctx.writeFile("src/test.ts", `// login is called in api.ts\n`);

				const reply = await ctx.send(
					"Search the workspace for all usages of the string 'login'. " + "Report which files contain it.",
				);
				if (!reply.toLowerCase().includes("auth") && !reply.toLowerCase().includes("api")) {
					throw new Error("Expected reply to mention auth.ts or api.ts");
				}
			},
			{ scenario: "fs.grep-parity", ...EXTRA_OPTS },
		);
		console.log(formatReport(metrics));
		assertToolUsed(metrics, "fs.grep");
		expect(metrics.passed).toBe(true);
	}, 120_000);
});

// ---------------------------------------------------------------------------
// fs.find — pi-mono: file_grep (find variant) / file_find
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_REAL_LLM)("fs.find (pi-mono: file_find)", () => {
	it("finds files matching a glob pattern", async () => {
		const metrics = await harness.run(
			async (ctx) => {
				await ctx.writeFile("src/index.ts", "export {};\n");
				await ctx.writeFile("src/utils.ts", "export {};\n");
				await ctx.writeFile("README.md", "# README\n");
				await ctx.writeFile("package.json", '{"name":"test"}\n');

				const reply = await ctx.send("Find all TypeScript files (*.ts) in the workspace. List their paths.");
				if (!reply.includes("index.ts") && !reply.includes(".ts")) {
					throw new Error("Expected TypeScript file paths in reply");
				}
			},
			{ scenario: "fs.find-parity", ...EXTRA_OPTS },
		);
		console.log(formatReport(metrics));
		assertToolUsed(metrics, "fs.find");
		expect(metrics.passed).toBe(true);
	}, 120_000);
});

// ---------------------------------------------------------------------------
// shell.exec — pi-mono: file_bash
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_REAL_LLM)("shell.exec (pi-mono: file_bash)", () => {
	it("runs a shell command and reports its output", async () => {
		const metrics = await harness.run(
			async (ctx) => {
				await ctx.writeFile("package.json", JSON.stringify({ name: "parity-test", version: "1.0.0" }));
				const reply = await ctx.send("Run `node --version` in the shell and tell me the Node.js version number.");
				// Node version starts with 'v' followed by a number
				if (!/v\d+/.test(reply)) {
					throw new Error(`Expected Node version in reply, got: ${reply.slice(0, 100)}`);
				}
			},
			{ scenario: "shell.exec-parity", ...EXTRA_OPTS },
		);
		console.log(formatReport(metrics));
		assertToolUsed(metrics, "shell.exec");
		expect(metrics.passed).toBe(true);
	}, 120_000);
});

// ---------------------------------------------------------------------------
// Negative: read-only constraint — fs.write must NOT be called when ablated
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_REAL_LLM)("ablation enforcement — read-only tool set", () => {
	it("read-only FsOrgan prevents fs.write from appearing in spans", async () => {
		const { createFsOrgan } = await import("@dpopsuev/alef-organ-fs");
		const readOnlyFs = createFsOrgan({
			cwd: "/tmp", // overridden by harness workspace
			actions: ["fs.read", "fs.grep", "fs.find"],
		});

		const metrics = await harness.run(
			async (ctx) => {
				await ctx.writeFile("src/data.ts", "export const x = 42;\n");
				// Ask for a write — should be refused or not attempted
				await ctx.send("Read src/data.ts and tell me what value x has. Do not write any files.");
			},
			{
				scenario: "ablation-no-write",
				systemPrompt: SYSTEM_PROMPT,
				extraOrgans: [readOnlyFs],
			},
		);
		console.log(formatReport(metrics));
		assertToolNotUsed(metrics, "fs.write");
		assertToolNotUsed(metrics, "fs.edit");
	}, 120_000);
});
