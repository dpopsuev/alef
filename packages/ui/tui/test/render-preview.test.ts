import { describe, expect, it } from "vitest";
import { stripAnsi } from "../src/views/ansi-utils.js";
import { renderDisplayBlocksToLines } from "../src/views/render-preview.js";
import type { ThemeTokens } from "../src/theme-types.js";

const C = { ansi16: 37 };
function theme(): ThemeTokens {
	return {
		userFg: C,
		userBg: C,
		agentFg: C,
		agentBg: C,
		primaryFg: C,
		secondaryFg: C,
		mutedFg: C,
		accentFg: C,
		brightFg: C,
		okFg: C,
		warnFg: C,
		errFg: C,
	};
}

describe("renderDisplayBlocksToLines", { tags: ["unit"] }, () => {
	it("hosts blocks through ChatLog chrome", () => {
		const lines = renderDisplayBlocksToLines(
			[
				{ kind: "user", text: "hello" },
				{ kind: "assistant", text: "world" },
				{ kind: "tool", name: "fs.read", summary: "/tmp/a.ts" },
			],
			80,
			theme(),
		).map(stripAnsi);

		expect(lines.some((line) => line.includes("@you"))).toBe(true);
		expect(lines.some((line) => line.includes("hello"))).toBe(true);
		expect(lines.some((line) => line.includes("@alef"))).toBe(true);
		expect(lines.some((line) => line.includes("world"))).toBe(true);
		expect(lines.some((line) => line.includes("fs.read"))).toBe(true);
		expect(lines.some((line) => line.includes("/tmp/a.ts"))).toBe(true);
		expect(lines.every((line) => !line.includes("▸") && !line.includes("◂"))).toBe(true);
	});

	it("returns empty-session placeholder for no blocks", () => {
		expect(renderDisplayBlocksToLines([], 40, theme())).toEqual(["  (empty session)"]);
	});
});
