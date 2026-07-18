import { describe, expect, it } from "vitest";
import { selectListThemeFromTokens, type ThemeTokens } from "../src/client/theme.js";

function tokens(): ThemeTokens {
	return {
		userFg: { ansi16: 95 },
		userBg: { ansi16: 45 },
		agentFg: { ansi16: 96 },
		agentBg: { ansi16: 40 },
		primaryFg: { ansi16: 34 },
		secondaryFg: { ansi16: 36 },
		mutedFg: { ansi16: 90 },
		accentFg: { ansi16: 95 },
		brightFg: { ansi16: 97 },
		okFg: { ansi16: 32 },
		warnFg: { ansi16: 33 },
		errFg: { ansi16: 31 },
	};
}

describe("selectListThemeFromTokens chrome", { tags: ["unit"] }, () => {
	it("paints selection with accentFg and brightFg for selected descriptions", () => {
		const theme = selectListThemeFromTokens(tokens(), "accent-bold-text");
		expect(theme.unselectedText).toBeTypeOf("function");
		expect(theme.selectedDescription).toBeTypeOf("function");
		const selected = theme.selectedText("q");
		const unselected = theme.unselectedText!("help");
		const desc = theme.selectedDescription!(" Quit");
		expect(selected).toContain("q");
		expect(unselected).toContain("help");
		expect(desc).toContain("Quit");
		// Selected = accent (95); unselected = muted (90); description = bright (97).
		expect(selected).toMatch(/95|1;/);
		expect(unselected).toMatch(/90/);
		expect(desc).toMatch(/97/);
	});
});
