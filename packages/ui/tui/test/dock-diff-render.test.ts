/**
 * Dock differential rendering — only changed lines are repainted.
 * Verifies that the dock path uses absolute cursor positioning and
 * skips unchanged lines to eliminate flicker.
 */

import { describe, expect, it } from "vitest";
import { Text } from "../src/components/text.js";
import { Container, TUI } from "../src/tui.js";
import { DynamicText } from "../src/views/index.js";
import { CapturingTerminal } from "./capturing-terminal.js";

function makeEnv(cols = 40, rows = 8) {
	const terminal = new CapturingTerminal(cols, rows);
	const tui = new TUI(terminal);
	terminal.start(
		() => {},
		() => {},
	);
	tui.start();
	return { terminal, tui };
}

async function settle(ms = 30): Promise<void> {
	await new Promise<void>((r) => process.nextTick(r));
	await new Promise<void>((r) => setTimeout(r, ms));
}

describe("dock differential rendering", { tags: ["unit"] }, () => {
	it("reports diff render path when only dock content changes", async () => {
		const { tui, terminal } = makeEnv(40, 6);
		const chat = new Container();
		tui.addChild(chat);
		for (let i = 0; i < 10; i++) chat.addChild(new Text(`chat-${i}`, 0, 0));

		let tick = 0;
		const status = new DynamicText(() => `status:${tick}`);
		tui.addChild(status);
		tui.setDock(status);

		tui.requestRender(true);
		await settle();

		tick = 1;
		tui.requestRender();
		await settle();

		expect(tui.renderMeta.renderPath).toBe("diff");
	});

	it("skips unchanged lines in the diff frame", async () => {
		const { tui, terminal } = makeEnv(40, 6);
		const chat = new Container();
		tui.addChild(chat);
		for (let i = 0; i < 10; i++) chat.addChild(new Text(`chat-${i}`, 0, 0));

		let tick = 0;
		const status = new DynamicText(() => `status:${tick}`);
		tui.addChild(status);
		tui.setDock(status);

		tui.requestRender(true);
		await settle();

		terminal.clearLog();
		tick = 1;
		tui.requestRender();
		await settle();

		const raw = terminal.getRawLog();
		// Only the dock line changed — chat lines should NOT appear in the diff frame
		expect(raw).toContain("status:1");
		expect(raw).not.toContain("chat-");
	});

	it("clears only changed lines, not the entire viewport", async () => {
		const { tui, terminal } = makeEnv(40, 6);
		const chat = new Container();
		tui.addChild(chat);
		for (let i = 0; i < 10; i++) chat.addChild(new Text(`chat-${i}`, 0, 0));

		let tick = 0;
		const status = new DynamicText(() => `status:${tick}`);
		tui.addChild(status);
		tui.setDock(status);

		tui.requestRender(true);
		await settle();

		terminal.clearLog();
		tick = 1;
		tui.requestRender();
		await settle();

		const raw = terminal.getRawLog();
		// Count \x1b[2K (erase-line) sequences -- should match the number
		// of actually changed lines (1 dock line), not the full viewport (6).
		const clearLineCount = (raw.match(/\x1b\[2K/g) ?? []).length;
		expect(clearLineCount).toBe(1);
	});

	it("erase-line count matches changed-line count across multiple updates", async () => {
		const { tui, terminal } = makeEnv(40, 8);
		const chat = new Container();
		tui.addChild(chat);
		for (let i = 0; i < 20; i++) chat.addChild(new Text(`msg-${i}`, 0, 0));

		let spinner = "|";
		const status = new DynamicText(() => `status ${spinner}`);
		const footer = new Text("footer", 0, 0);
		tui.addChild(status);
		tui.setDock(status);
		tui.addChild(footer);

		tui.requestRender(true);
		await settle();

		const frames = ["/", "-", "\\", "|"];
		for (const frame of frames) {
			terminal.clearLog();
			spinner = frame;
			tui.requestRender();
			await settle(20);

			const raw = terminal.getRawLog();
			const eraseCount = (raw.match(/\x1b\[2K/g) ?? []).length;
			// Only the status line changes; footer and chat are stable.
			expect(eraseCount).toBe(1);
		}
	});

	it("frame byte volume is proportional to changed lines, not viewport size", async () => {
		const { tui, terminal } = makeEnv(40, 20);
		const chat = new Container();
		tui.addChild(chat);
		for (let i = 0; i < 40; i++) chat.addChild(new Text(`chat-line-${i}`, 0, 0));

		let tick = 0;
		const dock = new DynamicText(() => `dock:${tick}`);
		tui.addChild(dock);
		tui.setDock(dock);

		tui.requestRender(true);
		await settle();

		// Full initial frame
		const fullFrameBytes = terminal.getRawLog().length;

		terminal.clearLog();
		tick = 1;
		tui.requestRender();
		await settle();

		// Diff frame with 1 changed line should be much smaller than the full frame
		const diffFrameBytes = terminal.getRawLog().length;
		expect(diffFrameBytes).toBeLessThan(fullFrameBytes / 2);
	});

	it("wraps every diff frame in synchronized output brackets", async () => {
		const { tui, terminal } = makeEnv(40, 6);
		const chat = new Container();
		tui.addChild(chat);
		for (let i = 0; i < 10; i++) chat.addChild(new Text(`chat-${i}`, 0, 0));

		let tick = 0;
		const dock = new DynamicText(() => `dock:${tick}`);
		tui.addChild(dock);
		tui.setDock(dock);

		tui.requestRender(true);
		await settle();
		terminal.clearLog();

		for (let i = 1; i <= 3; i++) {
			tick = i;
			tui.requestRender();
			await settle(20);
		}

		const frames = terminal.getFrames();
		for (const frame of frames) {
			expect(frame.syncBegin).toBe(true);
			expect(frame.syncEnd).toBe(true);
		}
	});

	it("uses absolute cursor positioning in diff frames", async () => {
		const { tui, terminal } = makeEnv(40, 6);
		const chat = new Container();
		tui.addChild(chat);
		for (let i = 0; i < 10; i++) chat.addChild(new Text(`chat-${i}`, 0, 0));

		let tick = 0;
		const status = new DynamicText(() => `status:${tick}`);
		tui.addChild(status);
		tui.setDock(status);

		tui.requestRender(true);
		await settle();

		terminal.clearLog();
		tick = 1;
		tui.requestRender();
		await settle();

		const raw = terminal.getRawLog();
		// Absolute positioning: \x1b[row;1H (1-based row)
		expect(raw).toMatch(/\x1b\[\d+;1H/);
		// No relative cursor moves (the source of drift)
		expect(raw).not.toMatch(/\x1b\[\d+A/);
		expect(raw).not.toMatch(/\x1b\[\d+B/);
	});

	it("reports no-change when nothing changed", async () => {
		const { tui } = makeEnv(40, 6);
		const chat = new Container();
		tui.addChild(chat);
		chat.addChild(new Text("hello", 0, 0));

		const status = new Text("dock", 0, 0);
		tui.addChild(status);
		tui.setDock(status);

		tui.requestRender(true);
		await settle();

		// Re-render with identical content
		tui.requestRender();
		await settle();

		expect(tui.renderMeta.renderPath).toBe("no-change");
	});

	it("does not emit clear-screen during differential dock renders", async () => {
		const { tui, terminal } = makeEnv(40, 6);
		const chat = new Container();
		tui.addChild(chat);
		for (let i = 0; i < 10; i++) chat.addChild(new Text(`chat-${i}`, 0, 0));

		let tick = 0;
		const status = new DynamicText(() => `tick:${tick}`);
		tui.addChild(status);
		tui.setDock(status);

		tui.requestRender(true);
		await settle();
		terminal.clearLog();

		for (let i = 1; i <= 5; i++) {
			tick = i;
			tui.requestRender();
			await settle(20);
		}

		const frames = terminal.getFrames();
		for (const frame of frames) {
			expect(frame.hasClearScreen).toBe(false);
		}
	});

	it("preserves viewport content across multiple dock-only updates", async () => {
		const { tui, terminal } = makeEnv(40, 6);
		const chat = new Container();
		tui.addChild(chat);
		for (let i = 0; i < 10; i++) chat.addChild(new Text(`chat-${i}`, 0, 0));

		let tick = 0;
		const status = new DynamicText(() => `spinner:${tick}`);
		tui.addChild(status);
		tui.setDock(status);

		tui.requestRender(true);
		await settle();

		for (let i = 1; i <= 10; i++) {
			tick = i;
			tui.requestRender();
			await settle(20);
		}

		const viewport = await terminal.flushAndGetViewport();
		// Dock line has latest value
		expect(viewport.some((l) => l.includes("spinner:10"))).toBe(true);
		// Chat body is intact (last 5 visible lines of 10 chat lines in 6-row terminal)
		expect(viewport.some((l) => l.includes("chat-"))).toBe(true);
	});

	it("falls back to full render on dock height change", async () => {
		const { tui, terminal } = makeEnv(40, 6);
		const chat = new Container();
		tui.addChild(chat);
		for (let i = 0; i < 10; i++) chat.addChild(new Text(`chat-${i}`, 0, 0));

		const dockRoot = new Container();
		tui.addChild(dockRoot);
		tui.setDock(dockRoot);
		dockRoot.addChild(new Text("line1", 0, 0));

		tui.requestRender(true);
		await settle();

		// Add a second dock line — dock height changes
		dockRoot.addChild(new Text("line2", 0, 0));
		tui.requestRender();
		await settle();

		expect(tui.renderMeta.renderPath).toBe("dock-reflow");
	});

	it("handles simultaneous chat and dock changes", async () => {
		const { tui, terminal } = makeEnv(40, 6);
		const chat = new Container();
		tui.addChild(chat);
		for (let i = 0; i < 10; i++) chat.addChild(new Text(`msg-${i}`, 0, 0));

		let tick = 0;
		const dock = new DynamicText(() => `dock:${tick}`);
		tui.addChild(dock);
		tui.setDock(dock);

		tui.requestRender(true);
		await settle();

		// Both chat and dock change
		chat.addChild(new Text("msg-10", 0, 0));
		tick = 1;
		tui.requestRender();
		await settle();

		const viewport = await terminal.flushAndGetViewport();
		expect(viewport.some((l) => l.includes("dock:1"))).toBe(true);
	});
});
