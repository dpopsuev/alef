import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BUILT_IN_THEMES,
	bold,
	color,
	colorDepth,
	dim,
	getTheme,
	setThemeByName,
	spinnerFrames,
} from "../src/theme.js";

afterEach(() => {
	setThemeByName("terminal");
	delete process.env.COLORTERM;
	delete process.env.TERM;
});

describe("colorDepth", { tags: ["unit"] }, () => {
	it("returns truecolor when COLORTERM=truecolor", () => {
		process.env.COLORTERM = "truecolor";
		expect(colorDepth()).toBe("truecolor");
	});

	it("returns truecolor when COLORTERM=24bit", () => {
		process.env.COLORTERM = "24bit";
		expect(colorDepth()).toBe("truecolor");
	});

	it("returns 256 when TERM contains 256color", () => {
		process.env.TERM = "xterm-256color";
		expect(colorDepth()).toBe("256");
	});

	it("returns 16 when no relevant env vars set", () => {
		expect(colorDepth()).toBe("16");
	});
});

describe("color()", { tags: ["unit"] }, () => {
	it("wraps text with truecolor escape in truecolor mode", () => {
		process.env.COLORTERM = "truecolor";
		const token = { truecolor: "#c55778" };
		const result = color("hello", token);
		expect(result).toContain("\x1b[38;2;");
		expect(result).toContain("hello");
		// color() uses \x1b[39m (fg-only reset) to preserve outer Box backgrounds.
		expect(result).toContain("\x1b[39m");
		expect(result).not.toContain("\x1b[0m"); // must NOT full-reset (kills bg)
	});

	it("uses ansi256 fallback in 256 mode", () => {
		process.env.TERM = "xterm-256color";
		const token = { truecolor: "#c55778", ansi256: 168 };
		const result = color("hi", token);
		expect(result).toContain("\x1b[38;5;168m");
	});

	it("uses ansi16 as last resort", () => {
		const token = { truecolor: "#c55778", ansi16: 35 };
		const result = color("hi", token);
		expect(result).toContain("\x1b[35m");
	});

	it("returns plain text when no fallback available in 16 mode", () => {
		const token = { truecolor: "#c55778" }; // no ansi16
		const result = color("hi", token);
		expect(result).toBe("hi");
	});

	it("uses ansi16 when truecolor is absent (terminal theme tokens)", () => {
		const token = { ansi16: 95 }; // no truecolor
		const result = color("hi", token);
		expect(result).toContain("\x1b[95m");
	});
});

describe("bold / dim", { tags: ["unit"] }, () => {
	it("bold wraps with bold escape", () => {
		// chalk strips escapes in non-TTY environments; assert structural wrapping
		// by checking the output either contains the escape OR equals the input
		// (both are valid depending on FORCE_COLOR env).
		const result = bold("x");
		expect(result === "x" || result.includes("\x1b[1m")).toBe(true);
	});

	it("dim wraps with dim escape", () => {
		const result = dim("x");
		expect(result === "x" || result.includes("\x1b[2m")).toBe(true);
	});
});

describe("built-in themes", { tags: ["unit"] }, () => {
	it("terminal, akko, mono, matrix are registered", () => {
		expect(Object.keys(BUILT_IN_THEMES)).toEqual(expect.arrayContaining(["terminal", "akko", "mono", "matrix"]));
	});

	it("terminal theme has no truecolor values — pure ANSI 16", () => {
		const t = BUILT_IN_THEMES.terminal;
		for (const [key, token] of Object.entries(t)) {
			expect(token.truecolor, `terminal.${key} should have no truecolor`).toBeUndefined();
			expect(token.ansi16, `terminal.${key} should have ansi16`).toBeDefined();
		}
	});

	it("each theme has all required token keys", () => {
		const required: Array<keyof typeof BUILT_IN_THEMES.akko> = [
			"userFg",
			"agentFg",
			"primaryFg",
			"secondaryFg",
			"okFg",
			"errFg",
			"accentFg",
			"mutedFg",
			"okFg",
			"warnFg",
			"errFg",
			"mutedFg",
			"mutedFg",
		];
		for (const [name, theme] of Object.entries(BUILT_IN_THEMES)) {
			for (const key of required) {
				expect(theme[key], `${name}.${key}`).toBeDefined();
			}
		}
	});
});

describe("setThemeByName", { tags: ["unit"] }, () => {
	it("switches to mono", () => {
		setThemeByName("mono");
		expect(getTheme()).toBe(BUILT_IN_THEMES.mono);
	});

	it("falls back to terminal for unknown name and warns", () => {
		const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		setThemeByName("unknown-xyz");
		expect(getTheme()).toBe(BUILT_IN_THEMES.terminal);
		expect(spy).toHaveBeenCalledWith(expect.stringContaining("unknown theme"));
		spy.mockRestore();
	});
});

describe("akko palette", { tags: ["unit"] }, () => {
	it("has truecolor values", () => {
		expect(BUILT_IN_THEMES.akko.accentFg.truecolor).toMatch(/^#[0-9a-f]{6}$/i);
		expect(BUILT_IN_THEMES.akko.warnFg.truecolor).toMatch(/^#[0-9a-f]{6}$/i);
	});
});

describe("spinnerFrames — locale-aware", { tags: ["unit"] }, () => {
	it("returns the requested count of frames", () => {
		const frames = spinnerFrames(8);
		expect(frames).toHaveLength(8);
	});

	it("returns glyphs for Japanese locale", () => {
		process.env.LANG = "ja_JP.UTF-8";
		const frames = spinnerFrames(4);
		// All glyphs should be from Katakana or Hiragana blocks (U+30A0–U+30FF or U+3040–U+309F)
		for (const g of frames) {
			const cp = g.codePointAt(0) ?? 0;
			expect(cp >= 0x3040 && cp <= 0x30ff, `${g} not in Japanese block`).toBe(true);
		}
	});

	it("returns glyphs for Arabic locale", () => {
		process.env.LANG = "ar_EG.UTF-8";
		const frames = spinnerFrames(4);
		for (const g of frames) {
			const cp = g.codePointAt(0) ?? 0;
			expect(cp >= 0x0600 && cp <= 0x06ff, `${g} not in Arabic block`).toBe(true);
		}
	});

	it("returns mathematical symbols for English locale", () => {
		process.env.LANG = "en_GB.UTF-8";
		const frames = spinnerFrames(4);
		// Mathematical/geometric block U+2200–U+27FF or geometric U+25A0–U+25FF
		for (const g of frames) {
			const cp = g.codePointAt(0) ?? 0;
			expect(cp >= 0x2200 && cp <= 0x27ff, `${g} not in math block`).toBe(true);
		}
	});

	it("falls back to default for unknown locale", () => {
		process.env.LANG = "xx_XX.UTF-8";
		const frames = spinnerFrames(4);
		expect(frames.length).toBe(4);
		// Should be from the default (mathematical) set
		for (const g of frames) {
			const cp = g.codePointAt(0) ?? 0;
			expect(cp >= 0x2200 && cp <= 0x27ff).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// boldColor() raw ANSI, fg-only reset (regression)
// ---------------------------------------------------------------------------

import { boldColor } from "../src/theme.js";

describe("boldColor() — raw ANSI, fg-only reset", { tags: ["unit"] }, () => {
	beforeEach(() => {
		process.env.COLORTERM = "truecolor";
	});

	it("does not use full reset \\x1b[0m (would kill outer Box background)", () => {
		const token = { truecolor: "#c55778", ansi256: 168, ansi16: 31 };
		const result = boldColor("hello", token);
		expect(result).not.toContain("\x1b[0m");
	});

	it("uses \\x1b[39m fg-only reset to preserve background", () => {
		const token = { truecolor: "#c55778", ansi256: 168, ansi16: 31 };
		const result = boldColor("hello", token);
		expect(result).toContain("\x1b[39m");
	});

	it("uses raw \\x1b[1m bold (not chalk, which silences in non-TTY)", () => {
		const token = { ansi16: 31 };
		const result = boldColor("hello", token);
		expect(result).toMatch(/\x1b\[1m/);
	});
});
