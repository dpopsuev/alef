/**
 * :command chrome — single lower delimiter, editor SelectList only (no hint grid).
 */
import type { TUI } from "@dpopsuev/alef-tui";
import { describe, expect, it } from "vitest";
import { PromptConsole } from "../src/client/console.js";
import { bold, color } from "../src/client/theme.js";

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function getTheme() {
	const W = { ansi16: 37 };
	return {
		userFg: W,
		userBg: W,
		agentFg: W,
		agentBg: W,
		primaryFg: W,
		secondaryFg: W,
		mutedFg: W,
		accentFg: W,
		brightFg: W,
		okFg: { ansi16: 32 },
		warnFg: { ansi16: 33 },
		errFg: { ansi16: 31 },
	};
}

describe("colon command chrome", { tags: ["unit"] }, () => {
	it("keeps INSERT on the last line while autocomplete is open — no orphan mid delimiter", async () => {
		const width = 80;
		const children: Array<{ render(w: number): string[] }> = [];
		const fakeTui = {
			addChild: (c: { render(w: number): string[] }) => children.push(c),
			removeChild: () => {},
			requestRender: () => {},
			addInputListener: () => {},
			setFocus: () => {},
			setStickyFrom: () => {},
			terminal: { rows: 40, cols: width },
		} as unknown as TUI;

		const zone = new PromptConsole(fakeTui, getTheme(), "test-model");
		zone.mount();
		zone.setStatus(color(bold("INSERT"), getTheme().accentFg));

		zone.editor.setAutocompleteProvider({
			getSuggestions: async (lines, _cursorLine, cursorCol) => {
				const prefix = (lines[0] ?? "").slice(0, cursorCol);
				if (!prefix.startsWith(":")) return null;
				return {
					items: [
						{ value: ":q", label: "q", description: "Quit" },
						{ value: ":help", label: "help", description: "Show help" },
					],
					prefix,
				};
			},
			applyCompletion: (lines, cursorLine, cursorCol, item, pfx) => {
				const line = lines[cursorLine] ?? "";
				const next = [...lines];
				next[cursorLine] = line.slice(0, cursorCol - pfx.length) + item.value + line.slice(cursorCol);
				return { lines: next, cursorLine, cursorCol: cursorCol - pfx.length + item.value.length };
			},
		});

		zone.editor.handleInput(":");
		await Promise.resolve();
		await new Promise((resolve) => setImmediate(resolve));

		const wrapper = children.find((child) => child.render(width).some((line) => stripAnsi(line).includes("INSERT")));
		expect(wrapper).toBeDefined();
		const lines = wrapper!.render(width).map(stripAnsi);
		const insertIdx = lines.findIndex((line) => /^─ INSERT /.test(line));
		expect(insertIdx).toBeGreaterThan(0);
		expect(lines.slice(insertIdx + 1).some((line) => line.includes("Quit"))).toBe(true);
		expect(lines.slice(0, insertIdx).some((line) => line.includes("Quit"))).toBe(false);
		const fullRules = lines.filter((line) => /^─+$/.test(line));
		expect(fullRules.length).toBeLessThanOrEqual(1);
		expect(lines.some((line) => line.includes(":restart") && line.includes(":update"))).toBe(false);
	});
});
