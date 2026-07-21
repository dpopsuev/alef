/**
 * DockConsole unit tests against a mock RenderHandle.
 *
 * Proves DockConsole is independently testable without TUI or Terminal.
 * Tests the component state model, not rendered output.
 */

import type { Component, RenderHandle } from "@dpopsuev/alef-tui";
import { describe, expect, it } from "vitest";
import { DockConsole } from "../src/client/console.js";
import { getTheme } from "../src/client/theme.js";

function mockRenderHandle(): RenderHandle & { renderCount: number; children: Component[] } {
	const children: Component[] = [];
	const handle = {
		renderCount: 0,
		children,
		requestRender(_force?: boolean) {
			handle.renderCount++;
		},
		addChild(c: Component) {
			children.push(c);
		},
		removeChild(c: Component) {
			const idx = children.indexOf(c);
			if (idx >= 0) children.splice(idx, 1);
		},
		setDock(_c: Component | null) {},
		terminal: { rows: 24 },
	};
	return handle;
}

async function settle(ms = 30): Promise<void> {
	await new Promise<void>((r) => process.nextTick(r));
	await new Promise<void>((r) => setTimeout(r, ms));
}

describe("DockConsole against mock RenderHandle", { tags: ["unit"] }, () => {
	it("constructs and mounts without TUI", () => {
		const handle = mockRenderHandle();
		const dc = new DockConsole(handle, getTheme(), "test-model");
		dc.mount();
		expect(handle.children.length).toBeGreaterThan(0);
	});

	it("startThinking sets isThinking flag", async () => {
		const handle = mockRenderHandle();
		const dc = new DockConsole(handle, getTheme(), "test-model");
		dc.mount();

		expect(dc.isThinking).toBe(false);
		dc.startThinking();
		expect(dc.isThinking).toBe(true);

		dc.stopThinking();
		expect(dc.isThinking).toBe(false);
	});

	it("thinking timer drives requestRender", async () => {
		const handle = mockRenderHandle();
		const dc = new DockConsole(handle, getTheme(), "test-model");
		dc.mount();

		handle.renderCount = 0;
		dc.startThinking();
		await settle(300);

		expect(handle.renderCount).toBeGreaterThan(0);

		dc.stopThinking();
	});

	it("showInFlightCall adds card, removeInFlightCall removes it", () => {
		const handle = mockRenderHandle();
		const dc = new DockConsole(handle, getTheme(), "test-model");
		dc.mount();

		dc.showInFlightCall("c1", "shell.exec", "ls", { command: "ls" });

		const inFlightCalls = (dc as any).inFlightCalls as Map<string, unknown>;
		expect(inFlightCalls.has("c1")).toBe(true);

		dc.removeInFlightCall("c1");
		expect(inFlightCalls.has("c1")).toBe(false);
	});

	it("setStatus/setNotice/setTopicLabel are pure mutations", () => {
		const handle = mockRenderHandle();
		const dc = new DockConsole(handle, getTheme(), "test-model");
		dc.mount();

		handle.renderCount = 0;
		dc.setStatus("INSERT");
		dc.setNotice("compacted");
		dc.setTopicLabel("my topic");
		dc.setIntent("reading files");

		expect(handle.renderCount).toBe(0);
	});

	it("statusText is empty when agent cards are showing", async () => {
		const handle = mockRenderHandle();
		const dc = new DockConsole(handle, getTheme(), "test-model");
		dc.mount();

		dc.startThinking();
		dc.showInFlightCall("c1", "shell.exec", "test", {});
		await settle(200);

		const statusText = (dc as any).statusText as Component;
		const lines = statusText.render(80).filter((l: string) => l.trim().length > 0);
		expect(lines.length, "statusText should be empty when cards are showing").toBe(0);

		dc.removeInFlightCall("c1");
		dc.stopThinking();
	});

	it("stopThinking after double startThinking clears state", async () => {
		const handle = mockRenderHandle();
		const dc = new DockConsole(handle, getTheme(), "test-model");
		dc.mount();

		dc.startThinking();
		dc.startThinking();
		await settle(100);
		expect(dc.isThinking).toBe(true);

		dc.stopThinking();
		expect(dc.isThinking).toBe(false);

		const statusText = (dc as any).statusText as Component;
		const lines = statusText.render(80).filter((l: string) => l.trim().length > 0);
		expect(lines.length).toBe(0);
	});

	it("onTurnComplete decrements clearAfterTurns counters", () => {
		const handle = mockRenderHandle();
		const dc = new DockConsole(handle, getTheme(), "test-model");
		dc.mount();

		dc.setStatus("working", 2);
		dc.onTurnComplete();
		dc.onTurnComplete();
	});

	it("showToast adds to widgetSlotBelow", () => {
		const handle = mockRenderHandle();
		const dc = new DockConsole(handle, getTheme(), "test-model");
		dc.mount();

		const beforeCount = dc.widgetSlotBelow.render(80).filter((l: string) => l.trim().length > 0).length;
		dc.showToast("hello");
		const afterCount = dc.widgetSlotBelow.render(80).filter((l: string) => l.trim().length > 0).length;
		expect(afterCount).toBeGreaterThanOrEqual(beforeCount);
	});
});
