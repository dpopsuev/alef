/**
 * AdapterTheme + TUI/history contribution slots
 *
 * Given/When/Then:
 *   Given AdapterTheme is defined in kernel
 *   When an adapter declares contributions["tui"] and contributions["history"]
 *   Then the types are accepted by AdapterContributions and the methods are callable
 */

import { describe, expect, it } from "vitest";
import type { AdapterContributions } from "../src/adapter/contributions.js";
import type { AdapterTheme } from "../src/adapter/ui.js";

describe("AdapterTheme — abstract semantic colour interface", { tags: ["unit"] }, () => {
	it("fg produces a styled string", () => {
		const theme: AdapterTheme = {
			fg: (color, text) => `[${color}]${text}[/${color}]`,
			bold: (text) => `*${text}*`,
			dim: (text) => `~${text}~`,
		};
		expect(theme.fg("accent", "hello")).toBe("[accent]hello[/accent]");
		expect(theme.bold("world")).toBe("*world*");
		expect(theme.dim("quiet")).toBe("~quiet~");
	});

	it("accepts all semantic colour tokens", () => {
		const colours = ["accent", "success", "error", "warning", "muted", "dim"] as const;
		const theme: AdapterTheme = {
			fg: (color, text) => `${color}:${text}`,
			bold: (text) => text,
			dim: (text) => text,
		};
		for (const c of colours) {
			expect(theme.fg(c, "x")).toBe(`${c}:x`);
		}
	});
});

describe("AdapterContributions — tui and history slots", { tags: ["unit"] }, () => {
	it("tui contribution compiles with renderCall and renderResult", () => {
		const contrib: AdapterContributions = {
			ui: {
				renderCall: (_name, _args, _theme) => null,
				renderResult: (_name, _result, _opts, _theme) => null,
				renderOverlay: () => null,
			},
		};
		expect(contrib.ui).toBeDefined();
		expect(contrib.ui?.renderCall?.("fs.read", {}, { fg: (_c, t) => t, bold: (t) => t, dim: (t) => t })).toBeNull();
	});

	it("history contribution compiles with ownedTools and extractEntry", () => {
		const contrib: AdapterContributions = {
			history: {
				ownedTools: ["fs.read", "fs.write", "fs.edit"],
				extractEntry: (payload) => ({ path: payload.path }),
			},
		};
		expect(contrib.history?.ownedTools).toContain("fs.read");
		expect(contrib.history?.extractEntry({ path: "/tmp/foo.ts" })).toEqual({ path: "/tmp/foo.ts" });
	});

	it("both slots are optional — organ without tui/history still compiles", () => {
		const contrib: AdapterContributions = {};
		expect(contrib.ui).toBeUndefined();
		expect(contrib.history).toBeUndefined();
	});
});
