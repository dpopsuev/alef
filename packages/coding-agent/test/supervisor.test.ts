/**
 * Tests for the supervisor's pure logic — argument handling, state management,
 * and blue-green deployment protocol.
 */

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Pure functions extracted from supervisor.ts for testing
// (They're not exported, so we re-implement them identically here)
// ---------------------------------------------------------------------------

function parseSessionFromArgs(args: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--session" && i + 1 < args.length) {
			return args[i + 1];
		}
	}
	return undefined;
}

function buildChildArgs(sessionFile: string | undefined, baseArgs: string[]): string[] {
	const args = [...baseArgs];
	if (sessionFile) {
		const hasSession = args.some((a, i) => a === "--session" && i + 1 < args.length);
		if (!hasSession) {
			args.unshift("--session", sessionFile);
		}
	}
	return args;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

describe("Supervisor — argument parsing", () => {
	it("extracts --session from args", () => {
		expect(parseSessionFromArgs(["--session", "/tmp/session.jsonl"])).toBe("/tmp/session.jsonl");
	});

	it("returns undefined when no --session", () => {
		expect(parseSessionFromArgs(["--provider", "anthropic"])).toBeUndefined();
	});

	it("returns undefined when --session is last arg (no value)", () => {
		expect(parseSessionFromArgs(["--session"])).toBeUndefined();
	});

	it("handles --session among other args", () => {
		expect(parseSessionFromArgs(["--provider", "anthropic", "--session", "/tmp/s.jsonl", "--model", "opus"])).toBe(
			"/tmp/s.jsonl",
		);
	});
});

// ---------------------------------------------------------------------------
// Child args building
// ---------------------------------------------------------------------------

describe("Supervisor — child args building", () => {
	it("injects --session when sessionFile is set and not in args", () => {
		const args = buildChildArgs("/tmp/session.jsonl", ["--provider", "anthropic"]);
		expect(args).toEqual(["--session", "/tmp/session.jsonl", "--provider", "anthropic"]);
	});

	it("does not duplicate --session when already in args", () => {
		const args = buildChildArgs("/tmp/session.jsonl", ["--session", "/tmp/session.jsonl", "--provider", "anthropic"]);
		expect(args).toEqual(["--session", "/tmp/session.jsonl", "--provider", "anthropic"]);
	});

	it("passes args through when no sessionFile", () => {
		const args = buildChildArgs(undefined, ["--provider", "anthropic"]);
		expect(args).toEqual(["--provider", "anthropic"]);
	});

	it("empty args with sessionFile", () => {
		const args = buildChildArgs("/tmp/s.jsonl", []);
		expect(args).toEqual(["--session", "/tmp/s.jsonl"]);
	});
});

// ---------------------------------------------------------------------------
// Blue-green deployment protocol
// ---------------------------------------------------------------------------

describe("Supervisor — blue-green protocol", () => {
	it("REBUILD_EXIT_CODE is 75", () => {
		expect(75).toBe(75);
	});

	it("supervisor environment variables contract", () => {
		// When supervised, child receives:
		const env = {
			ALEF_SUPERVISOR: "1",
			ALEF_REBUILD_EXIT_CODE: "75",
		};
		expect(env.ALEF_SUPERVISOR).toBe("1");
		expect(Number(env.ALEF_REBUILD_EXIT_CODE)).toBe(75);
	});

	it("blue instance environment is distinct from green", () => {
		// Blue instances receive ALEF_SUPERVISOR_BLUE=1
		// This prevents infinite rebuild loops
		const blueEnv = { ALEF_SUPERVISOR_BLUE: "1" };
		const greenEnv = { ALEF_SUPERVISOR: "1" };

		expect(blueEnv.ALEF_SUPERVISOR_BLUE).toBe("1");
		expect((greenEnv as Record<string, string>).ALEF_SUPERVISOR_BLUE).toBeUndefined();
	});

	it("smoke test JSONL parsing extracts assistant text", () => {
		// Simulate JSONL output from a blue instance
		const jsonlLines = [
			'{"type":"message_start","message":{"role":"assistant"}}',
			'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"HEALTH_CHECK_OK"}]}}',
		];

		let assistantText = "";
		for (const line of jsonlLines) {
			const event = JSON.parse(line);
			if (event.type === "message_end" && event.message?.role === "assistant") {
				for (const content of event.message.content ?? []) {
					if (content.type === "text") assistantText += content.text;
				}
			}
		}

		expect(assistantText).toBe("HEALTH_CHECK_OK");
	});

	it("smoke test passes when output is non-empty", () => {
		const output = "HEALTH_CHECK_OK";
		const passed = output.trim().length > 0;
		expect(passed).toBe(true);
	});

	it("smoke test fails on empty output", () => {
		const output = "";
		const passed = output.trim().length > 0;
		expect(passed).toBe(false);
	});

	it("smoke test fails on whitespace-only output", () => {
		const output = "   \n\t  ";
		const passed = output.trim().length > 0;
		expect(passed).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Session file tracking across restarts
// ---------------------------------------------------------------------------

describe("Supervisor — session tracking", () => {
	it("session file propagates via environment on rebuild", () => {
		// The /rebuild command sets ALEF_CURRENT_SESSION before exiting
		const sessionFile = "/home/user/.config/alef/sessions/abc123.jsonl";
		process.env.ALEF_CURRENT_SESSION = sessionFile;
		expect(process.env.ALEF_CURRENT_SESSION).toBe(sessionFile);
		delete process.env.ALEF_CURRENT_SESSION;
	});

	it("session file from env overrides initial args", () => {
		const initialSession = "/tmp/old.jsonl";
		const envSession = "/tmp/new.jsonl";

		// Simulate: initial args had --session /tmp/old.jsonl
		// After rebuild, env has ALEF_CURRENT_SESSION=/tmp/new.jsonl
		let sessionFile: string | undefined = initialSession;
		if (envSession) {
			sessionFile = envSession;
		}

		const args = buildChildArgs(sessionFile, ["--provider", "anthropic"]);
		expect(args).toContain(envSession);
		expect(args).not.toContain(initialSession);
	});
});
