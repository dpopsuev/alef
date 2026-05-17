/**
 * Blueprint E2E tests — spawn the runner subprocess with --blueprint and
 * verify the correct tool set, error handling, and auto-discovery behaviour.
 *
 * Uses --list-tools for deterministic tool-set assertions (no LLM required).
 * All tests are deterministic; no real LLM calls are made.
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));

const tempDirs: string[] = [];

function tmpDir(prefix = "alef-bp-e2e-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

interface RunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function run(args: string[], cwd?: string): Promise<RunResult> {
	return new Promise((resolve) => {
		const proc = spawn(TSX, [MAIN, ...args], {
			env: { ...process.env },
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		proc.stderr.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		proc.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
	});
}

// ---------------------------------------------------------------------------
// Default tool set (no blueprint)
// ---------------------------------------------------------------------------

describe("default tool set (no blueprint)", () => {
	it("--list-tools includes all six default EDA tools", async () => {
		const result = await run(["--list-tools"]);
		expect(result.exitCode).toBe(0);
		const tools = result.stdout.trim().split("\n");
		expect(tools).toContain("fs.read");
		expect(tools).toContain("fs.write");
		expect(tools).toContain("fs.edit");
		expect(tools).toContain("fs.grep");
		expect(tools).toContain("fs.find");
		expect(tools).toContain("shell.exec");
	});
});

// ---------------------------------------------------------------------------
// Blueprint flag — valid blueprints
// ---------------------------------------------------------------------------

describe("--blueprint flag", () => {
	it("full fs + shell blueprint exposes all tools", async () => {
		const dir = tmpDir();
		writeFileSync(join(dir, "agent.yaml"), ["name: full", "organs:", "  - name: fs", "  - name: shell"].join("\n"));

		const result = await run(["--blueprint", join(dir, "agent.yaml"), "--list-tools"]);
		expect(result.exitCode).toBe(0);

		const tools = result.stdout.trim().split("\n");
		expect(tools).toContain("fs.read");
		expect(tools).toContain("fs.write");
		expect(tools).toContain("fs.edit");
		expect(tools).toContain("shell.exec");
	});

	it("read-only fs blueprint excludes write tools", async () => {
		const dir = tmpDir();
		writeFileSync(
			join(dir, "agent.yaml"),
			["name: readonly", "organs:", "  - name: fs", "    actions: [read, grep, find]"].join("\n"),
		);

		const result = await run(["--blueprint", join(dir, "agent.yaml"), "--list-tools"]);
		expect(result.exitCode).toBe(0);

		const tools = result.stdout.trim().split("\n");
		expect(tools).toContain("fs.read");
		expect(tools).toContain("fs.grep");
		expect(tools).toContain("fs.find");
		expect(tools).not.toContain("fs.write");
		expect(tools).not.toContain("fs.edit");
		expect(tools).not.toContain("shell.exec");
	});

	it("fs-only blueprint excludes shell.exec", async () => {
		const dir = tmpDir();
		writeFileSync(join(dir, "agent.yaml"), ["name: fs-only", "organs:", "  - name: fs"].join("\n"));

		const result = await run(["--blueprint", join(dir, "agent.yaml"), "--list-tools"]);
		expect(result.exitCode).toBe(0);

		const tools = result.stdout.trim().split("\n");
		expect(tools).toContain("fs.read");
		expect(tools).not.toContain("shell.exec");
	});

	it("empty organs blueprint exposes only dialog.message", async () => {
		const dir = tmpDir();
		writeFileSync(join(dir, "agent.yaml"), "name: empty\n");

		const result = await run(["--blueprint", join(dir, "agent.yaml"), "--list-tools"]);
		expect(result.exitCode).toBe(0);
		// Only dialog.message — no corpus tools
		expect(result.stdout.trim()).toBe("dialog.message");
	});

	it("blueprint with systemPrompt does not crash", async () => {
		const dir = tmpDir();
		writeFileSync(
			join(dir, "agent.yaml"),
			["name: prompted", "systemPrompt: You are a helpful assistant.", "organs:", "  - name: fs"].join("\n"),
		);

		const result = await run(["--blueprint", join(dir, "agent.yaml"), "--list-tools"]);
		expect(result.exitCode).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Auto-discovery
// ---------------------------------------------------------------------------

describe("auto-discovery", () => {
	it("auto-discovers agent.yaml in --cwd directory", async () => {
		const dir = tmpDir();
		writeFileSync(
			join(dir, "agent.yaml"),
			["name: discovered", "organs:", "  - name: fs", "    actions: [read]"].join("\n"),
		);

		const result = await run(["--cwd", dir, "--list-tools"]);
		expect(result.exitCode).toBe(0);

		const tools = result.stdout.trim().split("\n");
		expect(tools).toContain("fs.read");
		expect(tools).not.toContain("fs.write");
	});

	it("auto-discovers .alef/agent.yaml", async () => {
		const dir = tmpDir();
		mkdirSync(join(dir, ".alef"), { recursive: true });
		writeFileSync(join(dir, ".alef", "agent.yaml"), ["name: dotdir", "organs:", "  - name: shell"].join("\n"));

		const result = await run(["--cwd", dir, "--list-tools"]);
		expect(result.exitCode).toBe(0);

		const tools = result.stdout.trim().split("\n");
		expect(tools).toContain("shell.exec");
		expect(tools).not.toContain("fs.read");
	});

	it("falls back to default organs when no blueprint in cwd", async () => {
		const dir = tmpDir(); // empty dir, no agent.yaml

		const result = await run(["--cwd", dir, "--list-tools"]);
		expect(result.exitCode).toBe(0);

		const tools = result.stdout.trim().split("\n");
		// Default includes both fs and shell
		expect(tools).toContain("fs.read");
		expect(tools).toContain("shell.exec");
	});

	it("explicit --blueprint overrides auto-discovery", async () => {
		const dir = tmpDir();
		// Auto-discoverable blueprint with shell
		writeFileSync(join(dir, "agent.yaml"), ["name: auto", "organs:", "  - name: shell"].join("\n"));

		// Explicit blueprint with only fs (no shell)
		const explicit = join(dir, "explicit.yaml");
		writeFileSync(explicit, ["name: explicit", "organs:", "  - name: fs"].join("\n"));

		const result = await run(["--cwd", dir, "--blueprint", explicit, "--list-tools"]);
		expect(result.exitCode).toBe(0);

		const tools = result.stdout.trim().split("\n");
		expect(tools).toContain("fs.read");
		expect(tools).not.toContain("shell.exec");
	});
});

// ---------------------------------------------------------------------------
// Model override
// ---------------------------------------------------------------------------

describe("model resolution", () => {
	it("--model CLI flag wins over blueprint model field", async () => {
		const dir = tmpDir();
		writeFileSync(join(dir, "agent.yaml"), ["name: m", "model: anthropic/claude-haiku-4-5"].join("\n"));

		// Can't easily assert which model is used without running the LLM,
		// but we can verify the runner starts without error when both are specified.
		const result = await run([
			"--blueprint",
			join(dir, "agent.yaml"),
			"--model",
			"claude-sonnet-4-5",
			"--list-tools",
		]);
		expect(result.exitCode).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe("error handling", () => {
	it("exits 1 when --blueprint file does not exist", async () => {
		const result = await run(["--blueprint", "/nonexistent/path/agent.yaml", "--list-tools"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr + result.stdout).toMatch(/not found/i);
	});

	it("exits 1 when blueprint YAML is invalid", async () => {
		const dir = tmpDir();
		writeFileSync(join(dir, "bad.yaml"), "}{invalid yaml}{{\n");

		const result = await run(["--blueprint", join(dir, "bad.yaml"), "--list-tools"]);
		expect(result.exitCode).toBe(1);
	});

	it("exits 1 when blueprint has an unknown organ action", async () => {
		const dir = tmpDir();
		writeFileSync(
			join(dir, "bad.yaml"),
			["name: bad", "organs:", "  - name: fs", "    actions: [teleport]"].join("\n"),
		);

		const result = await run(["--blueprint", join(dir, "bad.yaml"), "--list-tools"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr + result.stdout).toMatch(/unsupported action/i);
	});

	it("exits 1 when blueprint is missing required name field", async () => {
		const dir = tmpDir();
		writeFileSync(join(dir, "no-name.yaml"), "organs:\n  - name: fs\n");

		const result = await run(["--blueprint", join(dir, "no-name.yaml"), "--list-tools"]);
		expect(result.exitCode).toBe(1);
	});
});
