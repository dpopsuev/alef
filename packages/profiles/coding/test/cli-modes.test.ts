import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hasCredentials } from "@dpopsuev/alef-agent/model";

const MAIN = fileURLToPath(new URL("../../../cli/src/main.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
const TSCONFIG = fileURLToPath(new URL("../../../tsconfig.json", import.meta.url));

const SKIP_LLM = !hasCredentials() || !process.env.ALEF_E2E_TESTS;

interface RunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function run(args: string[]): Promise<RunResult> {
	return new Promise((resolve) => {
		const proc = spawn(TSX, [MAIN, ...args], {
			env: { ...process.env, TSX_TSCONFIG_PATH: TSCONFIG },
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		proc.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		proc.stdin.end();

		proc.on("close", (code) => {
			resolve({ stdout, stderr, exitCode: code ?? 1 });
		});
	});
}

describe.skipIf(SKIP_LLM)("CLI output modes — real LLM", { tags: ["real-llm"] }, () => {
	it("print mode: sends prompt, prints reply, exits 0", async () => {
		const result = await run(["-p", "Respond with exactly the word ALIVE and nothing else."]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toUpperCase()).toContain("ALIVE");
	}, 60_000);

	it("--json mode: output is valid JSONL with type=reply", async () => {
		const result = await run(["--json", "-p", "Say READY."]);
		expect(result.exitCode).toBe(0);

		const lines = result.stdout.trim().split("\n").filter(Boolean);
		expect(lines.length).toBeGreaterThan(0);

		const event = JSON.parse(lines[0]!);
		expect(event.type).toBe("reply");
		expect(typeof event.text).toBe("string");
		expect(typeof event.ts).toBe("number");
	}, 60_000);

	it("--cwd sets working directory for FsOrgan", async () => {
		const result = await run([
			"--cwd",
			fileURLToPath(new URL("../../../agent/src", import.meta.url)),
			"-p",
			"List the .ts files in the current directory. Just filenames, no explanation.",
		]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("main.ts");
	}, 60_000);
});
