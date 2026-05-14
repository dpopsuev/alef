/**
 * Unit tests for supervisor.ts pure helper functions.
 *
 * These functions have no I/O and no process spawn — they are deterministic
 * and testable in isolation. Covering them here means supervisor-process-proof
 * only needs to verify orchestration of already-proved components.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	buildChildArgs,
	collectFilePaths,
	getGreenInvocation,
	hashPathContents,
	hasProbeFlag,
	parseJsonArray,
	parseSessionFromArgs,
	parseUpdateScope,
	stripProbeFlag,
} from "../src/supervisor.js";

// ---------------------------------------------------------------------------
// parseSessionFromArgs
// ---------------------------------------------------------------------------

describe("parseSessionFromArgs", () => {
	it("returns undefined when --session is absent", () => {
		expect(parseSessionFromArgs([])).toBeUndefined();
		expect(parseSessionFromArgs(["--model", "claude"])).toBeUndefined();
	});

	it("returns the value that follows --session", () => {
		expect(parseSessionFromArgs(["--session", "/tmp/s.jsonl"])).toBe("/tmp/s.jsonl");
	});

	it("picks up --session anywhere in the array", () => {
		expect(parseSessionFromArgs(["--no-session", "--model", "x", "--session", "/s"])).toBe("/s");
	});

	it("ignores --session at the very end (no following value)", () => {
		expect(parseSessionFromArgs(["--model", "x", "--session"])).toBeUndefined();
	});

	it("returns the first occurrence when --session appears twice", () => {
		expect(parseSessionFromArgs(["--session", "first", "--session", "second"])).toBe("first");
	});
});

// ---------------------------------------------------------------------------
// stripProbeFlag / hasProbeFlag
// ---------------------------------------------------------------------------

describe("stripProbeFlag", () => {
	it("removes --probe from args", () => {
		expect(stripProbeFlag(["--probe", "--no-session"])).toEqual(["--no-session"]);
	});

	it("removes all occurrences of --probe", () => {
		expect(stripProbeFlag(["--probe", "a", "--probe"])).toEqual(["a"]);
	});

	it("returns empty array unchanged", () => {
		expect(stripProbeFlag([])).toEqual([]);
	});

	it("leaves non-probe args untouched", () => {
		expect(stripProbeFlag(["--model", "x", "--no-session"])).toEqual(["--model", "x", "--no-session"]);
	});
});

describe("hasProbeFlag", () => {
	it("returns true when --probe is present", () => {
		expect(hasProbeFlag(["--probe"])).toBe(true);
		expect(hasProbeFlag(["--no-session", "--probe", "--model", "x"])).toBe(true);
	});

	it("returns false when --probe is absent", () => {
		expect(hasProbeFlag([])).toBe(false);
		expect(hasProbeFlag(["--no-session"])).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// buildChildArgs
// ---------------------------------------------------------------------------

describe("buildChildArgs", () => {
	it("returns baseArgs unchanged when sessionFile is undefined", () => {
		expect(buildChildArgs(undefined, ["--no-session"])).toEqual(["--no-session"]);
	});

	it("prepends --session <file> when sessionFile is provided and absent from args", () => {
		const result = buildChildArgs("/tmp/s.jsonl", ["--no-session"]);
		expect(result).toEqual(["--session", "/tmp/s.jsonl", "--no-session"]);
	});

	it("does not duplicate --session when already present in baseArgs", () => {
		const result = buildChildArgs("/tmp/s.jsonl", ["--session", "/existing.jsonl", "--model", "x"]);
		expect(result).toEqual(["--session", "/existing.jsonl", "--model", "x"]);
	});

	it("does not mutate baseArgs", () => {
		const base = ["--no-session"];
		buildChildArgs("/tmp/s.jsonl", base);
		expect(base).toEqual(["--no-session"]);
	});

	it("prepends session to empty baseArgs", () => {
		expect(buildChildArgs("/s.jsonl", [])).toEqual(["--session", "/s.jsonl"]);
	});
});

// ---------------------------------------------------------------------------
// parseJsonArray
// ---------------------------------------------------------------------------

describe("parseJsonArray", () => {
	it("returns empty array for undefined", () => {
		expect(parseJsonArray(undefined)).toEqual([]);
	});

	it("returns empty array for empty string", () => {
		expect(parseJsonArray("")).toEqual([]);
	});

	it("parses a valid JSON string array", () => {
		expect(parseJsonArray('["a","b","c"]')).toEqual(["a", "b", "c"]);
	});

	it("filters out non-string elements", () => {
		expect(parseJsonArray('[1,"b",true,"c",null]')).toEqual(["b", "c"]);
	});

	it("returns empty array for a non-array JSON value", () => {
		expect(parseJsonArray('{"key":"value"}')).toEqual([]);
		expect(parseJsonArray('"just a string"')).toEqual([]);
		expect(parseJsonArray("42")).toEqual([]);
	});

	it("returns empty array for invalid JSON", () => {
		expect(parseJsonArray("not json")).toEqual([]);
		expect(parseJsonArray("[unclosed")).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// parseUpdateScope
// ---------------------------------------------------------------------------

describe("parseUpdateScope", () => {
	it("returns 'rebuild' for 'rebuild'", () => {
		expect(parseUpdateScope("rebuild")).toBe("rebuild");
	});

	it("returns 'packages' for 'packages'", () => {
		expect(parseUpdateScope("packages")).toBe("packages");
	});

	it("returns 'self' for 'self'", () => {
		expect(parseUpdateScope("self")).toBe("self");
	});

	it("returns undefined for unknown values", () => {
		expect(parseUpdateScope("unknown")).toBeUndefined();
		expect(parseUpdateScope("REBUILD")).toBeUndefined();
		expect(parseUpdateScope("")).toBeUndefined();
	});

	it("returns undefined for undefined", () => {
		expect(parseUpdateScope(undefined)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// getGreenInvocation
// ---------------------------------------------------------------------------

describe("getGreenInvocation", () => {
	const originalEnv = { ...process.env };

	afterEach(() => {
		// Restore env vars
		for (const key of ["ALEF_SUPERVISOR_GREEN_SCRIPT", "ALEF_SUPERVISOR_GREEN_ARGS"]) {
			if (key in originalEnv) {
				process.env[key] = originalEnv[key];
			} else {
				delete process.env[key];
			}
		}
	});

	it("uses ALEF_SUPERVISOR_GREEN_SCRIPT when set", () => {
		process.env.ALEF_SUPERVISOR_GREEN_SCRIPT = "/path/to/fake-green.js";
		delete process.env.ALEF_SUPERVISOR_GREEN_ARGS;

		const result = getGreenInvocation("/repo", ["--no-session"]);
		expect(result.command).toBe(process.execPath);
		expect(result.args[0]).toBe("/path/to/fake-green.js");
		expect(result.args).toContain("--no-session");
	});

	it("includes ALEF_SUPERVISOR_GREEN_ARGS in invocation", () => {
		process.env.ALEF_SUPERVISOR_GREEN_SCRIPT = "/green.js";
		process.env.ALEF_SUPERVISOR_GREEN_ARGS = '["--extra","flag"]';

		const result = getGreenInvocation("/repo", ["--no-session"]);
		expect(result.args).toContain("--extra");
		expect(result.args).toContain("flag");
		expect(result.args).toContain("--no-session");
	});

	it("childArgs appear after overrideArgs and before end", () => {
		process.env.ALEF_SUPERVISOR_GREEN_SCRIPT = "/green.js";
		process.env.ALEF_SUPERVISOR_GREEN_ARGS = '["--override"]';

		const result = getGreenInvocation("/repo", ["--child-arg"]);
		// ["/green.js", "--override", "--child-arg"]
		const overrideIdx = result.args.indexOf("--override");
		const childIdx = result.args.indexOf("--child-arg");
		expect(overrideIdx).toBeGreaterThan(-1);
		expect(childIdx).toBeGreaterThan(overrideIdx);
	});
});

// ---------------------------------------------------------------------------
// collectFilePaths / hashPathContents
// ---------------------------------------------------------------------------

describe("collectFilePaths", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "alef-helpers-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns empty array for empty directory", () => {
		expect(collectFilePaths(tmpDir)).toEqual([]);
	});

	it("returns file paths in the directory", () => {
		writeFileSync(join(tmpDir, "a.js"), "content a");
		writeFileSync(join(tmpDir, "b.js"), "content b");

		const paths = collectFilePaths(tmpDir);
		expect(paths.length).toBe(2);
		expect(paths.every((p) => p.endsWith(".js"))).toBe(true);
	});

	it("recurses into subdirectories", () => {
		mkdirSync(join(tmpDir, "sub"));
		writeFileSync(join(tmpDir, "root.js"), "r");
		writeFileSync(join(tmpDir, "sub", "child.js"), "c");

		const paths = collectFilePaths(tmpDir);
		expect(paths.length).toBe(2);
	});
});

describe("hashPathContents", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "alef-hash-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns a 64-char hex string", () => {
		writeFileSync(join(tmpDir, "f.js"), "x");
		const hash = hashPathContents(tmpDir);
		expect(hash).toMatch(/^[a-f0-9]{64}$/);
	});

	it("returns the same hash for identical content", () => {
		writeFileSync(join(tmpDir, "f.js"), "deterministic content");
		const h1 = hashPathContents(tmpDir);
		const h2 = hashPathContents(tmpDir);
		expect(h1).toBe(h2);
	});

	it("returns different hashes when content changes", () => {
		writeFileSync(join(tmpDir, "f.js"), "version 1");
		const h1 = hashPathContents(tmpDir);
		writeFileSync(join(tmpDir, "f.js"), "version 2");
		const h2 = hashPathContents(tmpDir);
		expect(h1).not.toBe(h2);
	});

	it("returns different hashes for different file names with same content", () => {
		writeFileSync(join(tmpDir, "a.js"), "same");
		const h1 = hashPathContents(tmpDir);
		rmSync(join(tmpDir, "a.js"));
		writeFileSync(join(tmpDir, "b.js"), "same");
		const h2 = hashPathContents(tmpDir);
		expect(h1).not.toBe(h2);
	});
});
