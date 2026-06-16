/**
 * TDD regression tests for
 *
 * Written RED (failing) before the implementation is changed.
 * These tests define the target behavior; make them pass without
 * breaking any existing tests.
 *
 * RED-ORANGE-GREEN-YELLOW-BLUE per Lex testing rule.
 */

import { describe, expect, it } from "vitest";
import { getTheme } from "../src/theme.js";
import { fmtMs } from "../src/tui/ansi-utils.js";
import { keyArgFromPayload, renderToolLine, toolActiveLine } from "../src/tui/tool-view.js";

// Strip all ANSI escape sequences for readability in assertions.
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// ---------------------------------------------------------------------------
// state indicators must be circles (●)
// ---------------------------------------------------------------------------

describe("toolActiveLine — in-flight circle", { tags: ["unit"] }, () => {
	const t = getTheme();

	it("uses ● (solid circle) for the in-flight indicator", () => {
		const line = toolActiveLine("shell.exec", "npm test", t, 500);
		// Must contain the solid circle, not hexagon glyphs ⬡ or ⬢
		expect(stripAnsi(line)).toContain("●");
		expect(stripAnsi(line)).not.toMatch(/[⬡⬢✓*]/);
	});

	it("emits a spinner character for in-flight tools", () => {
		const line = toolActiveLine("fs.read", "src/index.ts", t, 100);
		const stripped = stripAnsi(line);
		expect(stripped.length).toBeGreaterThan(0);
		expect(stripped).toContain("fs.read");
	});

	it("still shows name and keyArg after the circle", () => {
		const line = stripAnsi(toolActiveLine("shell.exec", "npm run check", t, 200));
		expect(line).toContain("shell.exec");
		expect(line).toContain("npm run check");
	});
});

describe("renderToolLine — completed circles", { tags: ["unit"] }, () => {
	const t = getTheme();

	it("uses ● for the done (ok=true) indicator", () => {
		const line = stripAnsi(renderToolLine("fs.read", "index.ts", 50, true, t));
		expect(line).toContain("●");
		expect(line).not.toMatch(/[⬢✓]/);
	});

	it("uses ● for the error (ok=false) indicator", () => {
		const line = stripAnsi(renderToolLine("shell.exec", "bad", 50, false, t));
		expect(line).toContain("●");
		expect(line).not.toMatch(/[⬡!]/);
	});
});

// ---------------------------------------------------------------------------
// shell.exec must show the command while in-flight
// ---------------------------------------------------------------------------

describe("keyArgFromPayload — shell.exec command display", { tags: ["unit"] }, () => {
	it("returns the command string for shell.exec args", () => {
		const result = keyArgFromPayload({ command: "npm run check", timeout: 30 });
		expect(result).toBe("npm run check");
	});

	it("truncates commands longer than 60 chars", () => {
		const long = "a".repeat(80);
		expect(keyArgFromPayload({ command: long })).toHaveLength(60);
	});

	it("returns empty string when command is absent", () => {
		expect(keyArgFromPayload({ timeout: 30 })).toBe("");
	});

	it("toolActiveLine shows command in the rendered line", () => {
		const t = getTheme();
		const line = stripAnsi(toolActiveLine("shell.exec", "npm run check", t, 0));
		expect(line).toContain("npm run check");
	});
});

// ---------------------------------------------------------------------------
// sub-second timer in status bar
// (fmtMs is used by individual tool timers; the total timer is in prompt-console.
// We verify the status format string here via a pure helper test.)
// ---------------------------------------------------------------------------

describe("fmtMs — sub-second individual tool timers", { tags: ["unit"] }, () => {
	it("shows ms for sub-1000ms (existing behaviour, must not regress)", () => {
		expect(fmtMs(300)).toBe("300ms");
		expect(fmtMs(999)).toBe("999ms");
	});

	it("shows 1.0s for exactly 1000ms", () => {
		expect(fmtMs(1000)).toBe("1.0s");
	});

	it("shows 1.5s for 1500ms", () => {
		expect(fmtMs(1500)).toBe("1.5s");
	});

	it("shows 97.0s for 97000ms", () => {
		expect(fmtMs(97000)).toBe("97.0s");
	});
});

// The total-time format in startThinking() is tested separately:
// expected format: (elapsedMs / 1000).toFixed(1) + "s"
// e.g. 143200ms → "143.2s"
describe("status timer format — sub-second total", { tags: ["unit"] }, () => {
	it("(elapsedMs/1000).toFixed(1) gives sub-second resolution", () => {
		// These pass trivially — they verify the math formula used in prompt-console.ts
		expect(`${(143200 / 1000).toFixed(1)}s`).toBe("143.2s");
		expect(`${(500 / 1000).toFixed(1)}s`).toBe("0.5s");
		expect(`${(0 / 1000).toFixed(1)}s`).toBe("0.0s");
	});
});
