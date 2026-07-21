/**
 * Scrollback purity — dock chrome (editor / INSERT / topic / footer) must
 * never enter archive write payloads or lines above the viewport.
 */

import { describe, expect, it } from "vitest";
import { Text } from "../src/components/text.js";
import { Container, TUI } from "../src/tui.js";
import { DynamicText } from "../src/views/index.js";
import { mountPromptConsoleDock } from "./fixtures/prompt-console-dock.js";
import { extractArchivePayloads, dockChromeHits } from "./fixtures/scrollback-purity.js";
import { VirtualTerminal } from "./virtual-terminal.js";

async function settle(ms = 25): Promise<void> {
	await new Promise<void>((r) => process.nextTick(r));
	await new Promise<void>((r) => setTimeout(r, ms));
}

function assertNoDockChrome(lines: string[], label: string): void {
	const hits = dockChromeHits(lines);
	expect(hits, `${label} must not contain dock chrome; hits=${hits.join(",")}`).toEqual([]);
}

describe("scrollback purity — dock chrome never archives", { tags: ["unit"] }, () => {
	it("archive payloads and above-viewport lines stay free of dock fingerprints", async () => {
		const terminal = new VirtualTerminal(48, 10);
		const writes: string[] = [];
		const originalWrite = terminal.write.bind(terminal);
		terminal.write = (data: string) => {
			writes.push(data);
			originalWrite(data);
		};

		const tui = new TUI(terminal);
		terminal.start(
			() => {},
			() => {},
		);
		tui.start();

		const chat = new Container();
		tui.addChild(chat);
		for (let i = 0; i < 3; i++) chat.addChild(new Text(`chat-seed-${i}`, 0, 0));

		let dockExtra: string[] = [];
		const dock = new DynamicText(() =>
			[
				"─ STICKY_TOPIC Explore the code base ─",
				"─ INSERT ─ STICKY_INSERT",
				"STICKY_EDITOR prompt line",
				...dockExtra,
				"STICKY_FOOTER ctx 19k",
			].join("\n"),
		);
		tui.addChild(dock);
		tui.setDock(dock);

		tui.requestRender(true);
		await settle();
		writes.length = 0;

		for (let i = 3; i < 24; i++) {
			chat.addChild(new Text(`chat-line-${i}`, 0, 0));
			tui.requestRender();
			await settle(12);
		}

		dockExtra = ["agent.run explore-1", "agent.run explore-2", "agent.run explore-3"];
		tui.requestRender();
		await settle();
		for (let i = 24; i < 36; i++) {
			chat.addChild(new Text(`chat-line-${i}`, 0, 0));
			tui.requestRender();
			await settle(12);
		}
		dockExtra = [];
		tui.requestRender();
		await settle();
		for (let i = 36; i < 48; i++) {
			chat.addChild(new Text(`chat-line-${i}`, 0, 0));
			tui.requestRender();
			await settle(12);
		}

		const archivePayloads = extractArchivePayloads(writes);
		expect(archivePayloads.length, "chat growth under dock must archive via scroll region").toBeGreaterThan(
			0,
		);
		assertNoDockChrome(archivePayloads, "archive payloads");

		const aboveViewport = terminal.getScrollbackAboveViewport();
		assertNoDockChrome(aboveViewport, "scrollback above viewport");

		expect(archivePayloads.join("\n")).toMatch(/chat-(seed|line)-/);

		const viewport = terminal.getViewport().join("\n");
		expect(viewport).toContain("STICKY_EDITOR");
		expect(viewport).toContain("STICKY_FOOTER");

		tui.stop();
	});

	it("dock height churn does not push editor chrome into scrollback", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		terminal.start(
			() => {},
			() => {},
		);
		tui.start();

		const chat = new Container();
		tui.addChild(chat);
		for (let i = 0; i < 12; i++) chat.addChild(new Text(`body-${i}`, 0, 0));

		let widgetCount = 0;
		const dock = new DynamicText(() => {
			const widgets = Array.from({ length: widgetCount }, (_, i) => `STICKY_INSERT widget-${i}`);
			return ["─ NORMAL ─ STICKY_TOPIC", ...widgets, "STICKY_EDITOR", "STICKY_FOOTER"].join("\n");
		});
		tui.addChild(dock);
		tui.setDock(dock);

		tui.requestRender(true);
		await settle();

		for (let round = 0; round < 6; round++) {
			widgetCount = round % 2 === 0 ? 4 : 0;
			chat.addChild(new Text(`body-grow-${round}`, 0, 0));
			tui.requestRender();
			await settle(15);
		}

		assertNoDockChrome(terminal.getScrollbackAboveViewport(), "scrollback after dock churn");
		expect(terminal.getViewport().some((line) => line.includes("STICKY_EDITOR"))).toBe(true);

		tui.stop();
	});

	it("DockConsole-shaped dock tree keeps archive paint pure under multi-agent churn", async () => {
		const terminal = new VirtualTerminal(72, 16);
		const writes: string[] = [];
		const originalWrite = terminal.write.bind(terminal);
		terminal.write = (data: string) => {
			writes.push(data);
			originalWrite(data);
		};

		const tui = new TUI(terminal);
		terminal.start(
			() => {},
			() => {},
		);
		tui.start();

		const fixture = mountPromptConsoleDock(tui);
		for (let i = 0; i < 4; i++) fixture.chat.addChild(new Text(`chat-seed-${i}`, 0, 0));

		tui.requestRender(true);
		await settle();
		writes.length = 0;

		const viewport0 = terminal.getViewport().join("\n");
		expect(viewport0).toMatch(/INSERT/);
		expect(viewport0).toContain("STICKY_TOPIC");
		expect(viewport0).toContain("STICKY_EDITOR");
		expect(viewport0).toContain("STICKY_FOOTER");

		// Overflow chat body (archive path).
		for (let i = 4; i < 28; i++) {
			fixture.chat.addChild(new Text(`chat-line-${i}`, 0, 0));
			tui.requestRender();
			await settle(12);
		}

		// Multi-agent explore: in-flight cards + thinking grow dock, then collapse.
		fixture.setThinkingLine("  ⠼ 42.2s");
		fixture.setInFlightLines([
			"agent.run explore schema",
			"agent.run explore tree-sitter",
			"agent.run explore graph-backend",
			"agent.run explore tests",
		]);
		tui.requestRender();
		await settle();

		for (let i = 28; i < 40; i++) {
			fixture.chat.addChild(new Text(`chat-line-${i}`, 0, 0));
			tui.requestRender();
			await settle(12);
		}

		fixture.setInFlightLines([]);
		fixture.setThinkingLine("");
		fixture.setMode("NORMAL");
		tui.requestRender();
		await settle();

		for (let i = 40; i < 52; i++) {
			fixture.chat.addChild(new Text(`chat-line-${i}`, 0, 0));
			tui.requestRender();
			await settle(12);
		}

		const archivePayloads = extractArchivePayloads(writes);
		expect(archivePayloads.length, "DockConsole dock must still archive chat").toBeGreaterThan(0);
		assertNoDockChrome(archivePayloads, "archive payloads (DockConsole shape)");
		assertNoDockChrome(terminal.getScrollbackAboveViewport(), "scrollback above viewport (DockConsole shape)");

		expect(archivePayloads.join("\n")).toMatch(/chat-(seed|line)-/);
		expect(terminal.getViewport().join("\n")).toContain("STICKY_EDITOR");

		tui.stop();
	});
});
