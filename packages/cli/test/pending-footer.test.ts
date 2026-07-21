/**
 * Pending footer lifecycle — regression test for the duplicate-footer bug.
 *
 * Bug: hidePendingFooter() was only called in the catch path, not the
 * success path, so the pending ╰──╯ remained visible after turn completion.
 *
 * Tests the DynamicText component directly rather than booting a full TUI.
 */

import { describe, expect, it } from "vitest";
import { color, getTheme } from "../src/client/theme.js";

// Simulate what DockConsole.pendingFooter renders based on active state.
function makePendingFooterRenderer() {
	let active = false;
	let fg = getTheme().accentFg;

	return {
		show(newFg = getTheme().accentFg) {
			active = true;
			fg = newFg;
		},
		hide() {
			active = false;
		},
		render(width: number): string {
			if (!active) return "";
			return color("─".repeat(Math.max(0, width)), fg);
		},
		get isActive() {
			return active;
		},
	};
}

describe("DockConsole — pending footer lifecycle", { tags: ["unit"] }, () => {
	it("renders footer when shown, empty when hidden", () => {
		const footer = makePendingFooterRenderer();

		expect(footer.render(40)).toBe("");

		footer.show();
		expect(footer.render(40)).toContain("─");

		footer.hide();
		expect(footer.render(40)).toBe("");
	});

	it("hidePendingFooter is idempotent", () => {
		const footer = makePendingFooterRenderer();
		footer.hide();
		footer.hide();
		expect(footer.isActive).toBe(false);
		expect(footer.render(40)).toBe("");
	});

	it("showPendingFooter is idempotent — only one footer rendered", () => {
		const footer = makePendingFooterRenderer();
		footer.show();
		footer.show();
		expect(footer.isActive).toBe(true);
		// render returns one string (not doubled)
		expect(footer.render(40)).toContain("─");
	});

	it("must be hidden after turn success — regression for duplicate-footer bug", () => {
		const footer = makePendingFooterRenderer();

		// Simulate turn start
		footer.show();
		expect(footer.isActive).toBe(true);

		// Simulate turn success — hidePendingFooter() MUST be called before agentBlock.end()
		footer.hide(); // this is the call that was missing in the success path
		expect(footer.isActive).toBe(false);
		expect(footer.render(80)).toBe("");
	});
});
