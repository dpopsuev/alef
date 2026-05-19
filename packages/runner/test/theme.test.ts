import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_THEMES, bold, color, colorDepth, dim, getTheme, setThemeByName } from "../src/theme.js";

afterEach(() => {
	setThemeByName("akko");
	delete process.env.COLORTERM;
	delete process.env.TERM;
});

describe("colorDepth", () => {
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

describe("color()", () => {
	it("wraps text with truecolor escape in truecolor mode", () => {
		process.env.COLORTERM = "truecolor";
		const token = { truecolor: "#c55778" };
		const result = color("hello", token);
		expect(result).toContain("\x1b[38;2;");
		expect(result).toContain("hello");
		expect(result).toContain("\x1b[0m");
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
		const token = { truecolor: "#c55778" };
		const result = color("hi", token);
		expect(result).toBe("hi");
	});
});

describe("bold / dim", () => {
	it("bold wraps with bold escape", () => {
		expect(bold("x")).toContain("\x1b[1m");
	});

	it("dim wraps with dim escape", () => {
		expect(dim("x")).toContain("\x1b[2m");
	});
});

describe("built-in themes", () => {
	it("akko, mono, matrix are registered", () => {
		expect(Object.keys(BUILT_IN_THEMES)).toEqual(expect.arrayContaining(["akko", "mono", "matrix"]));
	});

	it("each theme has all required token keys", () => {
		const required: Array<keyof typeof BUILT_IN_THEMES.akko> = [
			"userFg",
			"agentFg",
			"toolNameFg",
			"toolArgFg",
			"toolOkFg",
			"toolErrFg",
			"accentFg",
			"dimFg",
			"okFg",
			"warnFg",
			"errFg",
			"timeFg",
			"modelFg",
		];
		for (const [name, theme] of Object.entries(BUILT_IN_THEMES)) {
			for (const key of required) {
				expect(theme[key], `${name}.${key}`).toBeDefined();
			}
		}
	});
});

describe("setThemeByName", () => {
	it("switches to mono", () => {
		setThemeByName("mono");
		expect(getTheme()).toBe(BUILT_IN_THEMES.mono);
	});

	it("falls back to akko for unknown name and warns", () => {
		const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		setThemeByName("unknown-xyz");
		expect(getTheme()).toBe(BUILT_IN_THEMES.akko);
		expect(spy).toHaveBeenCalledWith(expect.stringContaining("unknown theme"));
		spy.mockRestore();
	});
});

describe("akko palette spot checks", () => {
	it("accent is blossom #c55778", () => {
		expect(BUILT_IN_THEMES.akko.accentFg.truecolor).toBe("#c55778");
	});

	it("toolNameFg is sky #6d9aba", () => {
		expect(BUILT_IN_THEMES.akko.toolNameFg.truecolor).toBe("#6d9aba");
	});

	it("warnFg is gold #d09e48", () => {
		expect(BUILT_IN_THEMES.akko.warnFg.truecolor).toBe("#d09e48");
	});
});
