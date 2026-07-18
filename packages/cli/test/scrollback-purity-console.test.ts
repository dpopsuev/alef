/**
 * Scrollback purity against the real PromptConsole mount order + EditorWrapper.
 */

import { Container, Text, TUI } from "@dpopsuev/alef-tui";
import { describe, expect, it } from "vitest";
import { extractArchivePayloads, stickyChromeHits } from "../../ui/tui/test/fixtures/scrollback-purity.js";
import { VirtualTerminal } from "../../ui/tui/test/virtual-terminal.js";
import { PromptConsole } from "../src/client/console.js";
import { getTheme } from "../src/client/theme.js";

async function settle(ms = 25): Promise<void> {
	await new Promise<void>((r) => process.nextTick(r));
	await new Promise<void>((r) => setTimeout(r, ms));
}

function assertNoStickyChrome(lines: string[], label: string): void {
	const hits = stickyChromeHits(lines);
	expect(hits, `${label} must not contain sticky chrome; hits=${hits.join(",")}`).toEqual([]);
}

describe("scrollback purity — real PromptConsole", { tags: ["unit"] }, () => {
	it("archive payloads stay free of INSERT/topic/editor chrome under agent.run churn", async () => {
		const terminal = new VirtualTerminal(72, 18);
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
		for (let i = 0; i < 4; i++) chat.addChild(new Text(`chat-seed-${i}`, 0, 0));

		const console = new PromptConsole(tui, getTheme(), "test-model");
		console.mount();
		console.setStatus("INSERT");
		console.setTopicLabel("STICKY_TOPIC Explore the code base");
		console.editor.setText("STICKY_EDITOR prompt line");
		tui.addChild(new Text("STICKY_FOOTER ctx 19k", 0, 0));

		tui.requestRender(true);
		await settle();
		writes.length = 0;

		for (let i = 4; i < 30; i++) {
			chat.addChild(new Text(`chat-line-${i}`, 0, 0));
			tui.requestRender();
			await settle(12);
		}

		console.startThinking();
		console.showInFlightCall("c1", "STICKY_CARD", "explore-schema", {});
		console.showInFlightCall("c2", "STICKY_CARD", "explore-indexer", {});
		console.showInFlightCall("c3", "STICKY_CARD", "explore-tests", {});
		tui.requestRender();
		await settle(40);

		for (let i = 30; i < 42; i++) {
			chat.addChild(new Text(`chat-line-${i}`, 0, 0));
			tui.requestRender();
			await settle(12);
		}

		console.removeInFlightCall("c1");
		console.removeInFlightCall("c2");
		console.removeInFlightCall("c3");
		console.stopThinking();
		console.setStatus("NORMAL");
		tui.requestRender();
		await settle();

		for (let i = 42; i < 54; i++) {
			chat.addChild(new Text(`chat-line-${i}`, 0, 0));
			tui.requestRender();
			await settle(12);
		}

		const archivePayloads = extractArchivePayloads(writes);
		expect(archivePayloads.length, "real PromptConsole must archive overflow chat").toBeGreaterThan(0);
		assertNoStickyChrome(archivePayloads, "archive payloads (real PromptConsole)");
		assertNoStickyChrome(terminal.getScrollbackAboveViewport(), "scrollback above viewport (real PromptConsole)");

		expect(archivePayloads.join("\n")).toMatch(/chat-(seed|line)-/);
		const viewport = terminal.getViewport().join("\n");
		expect(viewport).toMatch(/INSERT|NORMAL/);
		expect(viewport).toContain("STICKY_EDITOR");

		tui.stop();
	});
});
