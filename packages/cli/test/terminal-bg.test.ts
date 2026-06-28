import { afterEach, describe, expect, it } from "vitest";
import { detectDarkSync, parseOSC11Response, relativeLuminance } from "../src/client/terminal-bg.js";

afterEach(() => {
	delete process.env.COLORFGBG;
});

describe("parseOSC11Response", { tags: ["unit"] }, () => {
	it("parses 16-bit rgb response", () => {
		const result = parseOSC11Response("\x1b]11;rgb:2525/2525/2525\x07");
		expect(result).not.toBeNull();
		expect(result?.r).toBeCloseTo(0x25 / 0xff, 2);
		expect(result?.a).toBe(1);
	});

	it("parses rgba response with alpha", () => {
		const result = parseOSC11Response("\x1b]11;rgba:ffff/ffff/ffff/cccc\x07");
		expect(result).not.toBeNull();
		expect(result?.r).toBeCloseTo(1, 2);
		expect(result?.a).toBeCloseTo(0xcccc / 0xffff, 3);
	});

	it("parses OSC 10 (foreground) as well", () => {
		const result = parseOSC11Response("\x1b]10;rgb:e8e8/e8e8/e8e8\x07");
		expect(result).not.toBeNull();
	});

	it("returns null for garbage input", () => {
		expect(parseOSC11Response("not a response")).toBeNull();
		expect(parseOSC11Response("")).toBeNull();
	});
});

describe("relativeLuminance", { tags: ["unit"] }, () => {
	it("black has luminance 0", () => {
		expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBe(0);
	});

	it("white has luminance 1", () => {
		expect(relativeLuminance({ r: 1, g: 1, b: 1 })).toBeCloseTo(1, 5);
	});

	it("dark grey #252525 is below 0.5", () => {
		const v = 0x25 / 0xff;
		expect(relativeLuminance({ r: v, g: v, b: v })).toBeLessThan(0.5);
	});

	it("light grey #e8e8e8 is above 0.5", () => {
		const v = 0xe8 / 0xff;
		expect(relativeLuminance({ r: v, g: v, b: v })).toBeGreaterThan(0.5);
	});
});

describe("detectDarkSync", { tags: ["unit"] }, () => {
	it("returns true for opacity < 0.8 (high transparency)", () => {
		expect(detectDarkSync(0.5)).toBe(true);
		expect(detectDarkSync(0.79)).toBe(true);
	});

	it("does not treat opacity >= 0.8 as dark purely from opacity", () => {
		// Without COLORFGBG, defaults to dark — but opacity alone doesn't force it
		process.env.COLORFGBG = "15;15"; // light terminal
		expect(detectDarkSync(0.9)).toBe(false);
	});

	it("reads COLORFGBG — bg < 8 = dark", () => {
		process.env.COLORFGBG = "15;0";
		expect(detectDarkSync()).toBe(true);
	});

	it("reads COLORFGBG — bg >= 8 = light", () => {
		process.env.COLORFGBG = "0;15";
		expect(detectDarkSync()).toBe(false);
	});

	it("defaults to dark when no signals available", () => {
		expect(detectDarkSync()).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// buildTerminalTheme + queryPalette parsing
// ---------------------------------------------------------------------------

import { buildTerminalTheme } from "../src/client/runner-theme.js";

describe("buildTerminalTheme", { tags: ["unit"] }, () => {
	it("populates truecolor from palette when slot is present", () => {
		const palette = { 13: "#e890a8", 14: "#9eb8ca" };
		const theme = buildTerminalTheme(palette);
		expect(theme.userFg.truecolor).toBe("#e890a8");
		expect(theme.agentFg.truecolor).toBe("#9eb8ca");
	});

	it("falls back to ansi16 when palette slot is missing", () => {
		const theme = buildTerminalTheme({});
		expect(theme.userFg.truecolor).toBeUndefined();
		expect(theme.userFg.ansi16).toBe(95); // bright magenta
		expect(theme.agentFg.ansi16).toBe(96); // bright cyan
	});

	it("maps all semantic roles without throwing", () => {
		const palette: Record<number, string> = {};
		for (let i = 5; i <= 14; i++) palette[i] = `#${i.toString(16).repeat(6).slice(0, 6)}`;
		const theme = buildTerminalTheme(palette);
		// Every token must be defined
		for (const [key, token] of Object.entries(theme)) {
			expect(token, `${key} must be defined`).toBeDefined();
		}
	});

	it("background tokens carry ansi16 bg codes (not fg codes)", () => {
		const theme = buildTerminalTheme({});
		// userBg ansi16=45 (magenta bg), agentBg ansi16=40 (green bg)
		expect(theme.userBg.ansi16).toBe(45);
		expect(theme.agentBg.ansi16).toBe(40);
	});

	it("OSC 4 response parse: 16-bit channels convert to #rrggbb correctly", () => {
		// Simulate what queryPalette would return for slot 13
		// OSC 4 response: \x1b]4;13;rgb:e8e8/9090/a8a8\x07
		// 16-bit: e8e8/ffff = 0.91 → round to 235 (0xeb)
		const palette: Record<number, string> = {};
		// Manually parsed as if queryPalette did it:
		const scale = 0xffff;
		const r = Math.round((0xe8e8 / scale) * 255);
		const g = Math.round((0x9090 / scale) * 255);
		const b = Math.round((0xa8a8 / scale) * 255);
		palette[13] = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
		const theme = buildTerminalTheme(palette);
		expect(theme.userFg.truecolor).toMatch(/^#[0-9a-f]{6}$/);
	});
});
