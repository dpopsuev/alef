import { afterEach, describe, expect, it } from "vitest";
import { detectDarkSync, parseOSC11Response, relativeLuminance } from "../src/terminal-bg.js";

afterEach(() => {
	delete process.env.COLORFGBG;
});

describe("parseOSC11Response", () => {
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

describe("relativeLuminance", () => {
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

describe("detectDarkSync", () => {
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
