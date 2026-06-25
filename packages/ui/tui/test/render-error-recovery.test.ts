/**
 * Render error recovery — TUI must not crash when a component throws.
 *
 * The bug: scheduled renders (scheduleRender → doRender) have no
 * try/catch. If a component's render() throws, the error propagates
 * uncaught, crashing the process and dumping TUI content to the shell.
 */

import type { Component } from "../src/component.js";
import { describe, expect, it } from "vitest";
import { Text, TUI } from "../src/index.js";
import { VirtualTerminal } from "./virtual-terminal.js";

class ThrowingComponent implements Component {
	private shouldThrow = false;

	arm(): void {
		this.shouldThrow = true;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.shouldThrow) {
			throw new Error("Rendered line 54 exceeds terminal width (487 > 227)");
		}
		return ["safe-content"];
	}
}

describe("render error recovery", { tags: ["unit"] }, () => {
	it("TUI survives a component that throws during render", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);

		const safe = new Text("stable", 0, 0);
		const bomb = new ThrowingComponent();

		tui.addChild(safe);
		tui.addChild(bomb);

		tui.start();
		await terminal.waitForRender();

		// Verify initial render works
		let viewport = await terminal.flushAndGetViewport();
		expect(viewport.some((l) => l.includes("stable"))).toBe(true);
		expect(viewport.some((l) => l.includes("safe-content"))).toBe(true);

		// Arm the bomb — next render will throw
		bomb.arm();
		tui.requestRender();

		// This should NOT crash the process
		await terminal.waitForRender();

		// TUI should still be alive — stop cleanly
		tui.stop();
	});

	it("scheduled render catches errors and continues", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);

		const bomb = new ThrowingComponent();
		tui.addChild(bomb);

		tui.start();
		await terminal.waitForRender();

		bomb.arm();

		// Multiple rapid renders — all should be caught
		tui.requestRender();
		tui.requestRender();
		tui.requestRender();

		await terminal.waitForRender();
		await terminal.waitForRender();

		tui.stop();
		// If we get here, the TUI survived
	});
});
