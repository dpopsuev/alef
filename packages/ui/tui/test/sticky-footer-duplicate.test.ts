/**
 * Reproduce footer duplication when the sticky band grows/shrinks or the
 * terminal resizes — ghost footer lines left in the viewport.
 */
import { describe, expect, it } from "vitest";
import { Editor } from "../src/components/editor.js";
import { Text } from "../src/components/text.js";
import { Container, TUI } from "../src/tui.js";
import { DashboardFooter, DynamicText } from "../src/views/index.js";
import { TuiStateStore } from "../src/views/state.js";
import { VirtualTerminal } from "./virtual-terminal.js";

async function settle(ms = 40): Promise<void> {
	await new Promise<void>((r) => process.nextTick(r));
	await new Promise<void>((r) => setTimeout(r, ms));
	await new Promise<void>((r) => process.nextTick(r));
}

function countFooterLines(viewport: string[], marker = "FOOTER"): number {
	return viewport.filter((line) => line.includes(marker)).length;
}

function countCtxFooters(viewport: string[]): number {
	return viewport.filter((line) => /\bctx\b/.test(line) && /\d/.test(line)).length;
}

describe("sticky footer — no duplicate on resize / sticky reflow", { tags: ["unit"] }, () => {
	it("sticky growth then shrink leaves exactly one footer in the viewport", async () => {
		const terminal = new VirtualTerminal(60, 12);
		const tui = new TUI(terminal);
		terminal.start(
			() => {},
			() => {},
		);
		tui.start();

		const chat = new Container();
		tui.addChild(chat);
		for (let i = 0; i < 20; i++) chat.addChild(new Text(`chat-${i}`, 0, 0));

		const editor = new DynamicText(() => "EDITOR input");
		let autocompleteLines: string[] = [];
		const autocomplete = new DynamicText(() => autocompleteLines.join("\n"));
		let footerLabel = "FOOTER ctx 25k";
		const footer = new DynamicText(() => footerLabel);

		tui.addChild(editor);
		tui.setStickyFrom(editor);
		tui.addChild(autocomplete);
		tui.addChild(footer);

		tui.requestRender(true);
		await settle();
		expect(countFooterLines(terminal.getViewport())).toBe(1);

		// Open :command hints — sticky band grows (body shrinks).
		autocompleteLines = ["→ model  Switch model", "→ help   Show help", "→ q      Quit"];
		footerLabel = "FOOTER ctx 25k";
		tui.requestRender();
		await settle();
		expect(tui.renderMeta.renderPath).toBe("sticky-reflow");
		expect(countFooterLines(terminal.getViewport())).toBe(1);

		// Close hints + context tick — sticky shrinks; footer text changes.
		autocompleteLines = [];
		footerLabel = "FOOTER ctx 21k";
		tui.requestRender();
		await settle();
		expect(tui.renderMeta.renderPath).toBe("sticky-reflow");

		const viewport = terminal.getViewport();
		const footerHits = countFooterLines(viewport);
		expect(footerHits, `viewport:\n${viewport.map((l, i) => `${i}|${l}`).join("\n")}`).toBe(1);
		expect(viewport.some((line) => line.includes("21k"))).toBe(true);
		expect(viewport.some((line) => line.includes("25k"))).toBe(false);

		tui.stop();
	});

	it("height resize does not leave a ghost footer", async () => {
		const terminal = new VirtualTerminal(60, 14);
		const tui = new TUI(terminal);
		terminal.start(
			() => {},
			() => tui.requestRender(),
		);
		tui.start();

		const chat = new Container();
		tui.addChild(chat);
		for (let i = 0; i < 30; i++) chat.addChild(new Text(`chat-${i}`, 0, 0));

		let footerLabel = "FOOTER ctx 25k";
		const editor = new Text("EDITOR", 0, 0);
		const footer = new DynamicText(() => footerLabel);
		tui.addChild(editor);
		tui.setStickyFrom(editor);
		tui.addChild(footer);

		tui.requestRender(true);
		await settle();
		expect(countFooterLines(terminal.getViewport())).toBe(1);

		footerLabel = "FOOTER ctx 21k";
		terminal.resize(60, 10);
		await settle();

		const afterShrink = terminal.getViewport();
		expect(countFooterLines(afterShrink), `shrink:\n${afterShrink.map((l, i) => `${i}|${l}`).join("\n")}`).toBe(1);

		footerLabel = "FOOTER ctx 30k";
		terminal.resize(60, 16);
		await settle();

		const afterGrow = terminal.getViewport();
		expect(countFooterLines(afterGrow), `grow:\n${afterGrow.map((l, i) => `${i}|${l}`).join("\n")}`).toBe(1);
		expect(afterGrow.some((line) => line.includes("30k"))).toBe(true);

		tui.stop();
	});

	it("width resize that reflows sticky does not duplicate footer", async () => {
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TUI(terminal);
		terminal.start(
			() => {},
			() => tui.requestRender(),
		);
		tui.start();

		const chat = new Container();
		tui.addChild(chat);
		for (let i = 0; i < 15; i++) chat.addChild(new Text(`chat-${i}`, 0, 0));

		const longEditor = new Text("EDITOR " + "word ".repeat(40), 0, 0);
		const footer = new DynamicText(() => "FOOTER ctx 25k · model · : for commands");
		tui.addChild(longEditor);
		tui.setStickyFrom(longEditor);
		tui.addChild(footer);

		tui.requestRender(true);
		await settle();
		expect(countFooterLines(terminal.getViewport())).toBe(1);

		terminal.resize(40, 10);
		await settle();
		const narrow = terminal.getViewport();
		expect(countFooterLines(narrow), `narrow:\n${narrow.map((l, i) => `${i}|${l}`).join("\n")}`).toBe(1);

		terminal.resize(100, 10);
		await settle();
		const wide = terminal.getViewport();
		expect(countFooterLines(wide), `wide:\n${wide.map((l, i) => `${i}|${l}`).join("\n")}`).toBe(1);

		tui.stop();
	});

	it("editor autocomplete open/close + context tick leaves one dashboard footer", async () => {
		const terminal = new VirtualTerminal(100, 16);
		const tui = new TUI(terminal);
		terminal.start(
			() => {},
			() => tui.requestRender(),
		);
		tui.start();

		const chat = new Container();
		tui.addChild(chat);
		for (let i = 0; i < 25; i++) chat.addChild(new Text(`chat-${i}`, 0, 0));

		const editorTheme = {
			borderColor: (s: string) => s,
			selectList: {
				selectedPrefix: (s: string) => s,
				selectedText: (s: string) => s,
				description: (s: string) => s,
				scrollInfo: (s: string) => s,
				noMatch: (s: string) => s,
			},
		};
		const editor = new Editor(tui, editorTheme);
		editor.setText("");
		editor.setAutocompleteProvider({
			getSuggestions: async (lines, _cursorLine, cursorCol) => {
				const prefix = (lines[0] ?? "").slice(0, cursorCol);
				if (!prefix.startsWith(":")) return null;
				return {
					items: [
						{ value: ":model", label: "model", description: "Switch model" },
						{ value: ":help", label: "help", description: "Show help" },
						{ value: ":q", label: "q", description: "Quit" },
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

		const store = new TuiStateStore({
			modelId: "claude-opus-4-6",
			thinkingLevel: "none",
			inputTokens: 0,
			outputTokens: 0,
			contextWindow: 1_000_000,
			contextUsed: 25_000,
			compacted: false,
			costUsd: 0,
			blueprintName: "alef-coding-agent",
		});
		const footer = new DashboardFooter({
			sessionId: "test",
			cwd: "/home/dpopsuev/Workspace/alef",
			store,
			blueprintName: "alef-coding-agent",
			requestRender: () => tui.requestRender(),
			style: (s) => s,
			dimStyle: (s) => s,
			warnStyle: (s) => s,
			errorStyle: (s) => s,
		});

		// Match production: sticky from empty anchor through editor, then footer last.
		const stickyAnchor = new DynamicText(() => "");
		tui.addChild(stickyAnchor);
		tui.setStickyFrom(stickyAnchor);
		tui.addChild(editor);
		tui.setFocus(editor);
		tui.addChild(footer);

		tui.requestRender(true);
		await settle();
		expect(countCtxFooters(terminal.getViewport())).toBe(1);

		editor.handleInput(":");
		await settle(80);
		expect(editor.isShowingAutocomplete()).toBe(true);
		expect(countCtxFooters(terminal.getViewport())).toBe(1);

		// Context updates while autocomplete is open (store subscription → render).
		store.update({ contextUsed: 21_000 });
		await settle(80);
		expect(countCtxFooters(terminal.getViewport())).toBe(1);

		// Resize while autocomplete open — the reported failure mode.
		terminal.resize(90, 14);
		await settle(80);
		const mid = terminal.getViewport();
		expect(countCtxFooters(mid), `resize+ac:\n${mid.map((l, i) => `${i}|${l}`).join("\n")}`).toBe(1);

		// Dismiss autocomplete (Esc) and resize again.
		editor.handleInput("\x1b");
		await settle(80);
		terminal.resize(100, 18);
		await settle(80);

		const end = terminal.getViewport();
		expect(countCtxFooters(end), `final:\n${end.map((l, i) => `${i}|${l}`).join("\n")}`).toBe(1);

		footer.dispose();
		tui.stop();
	});
});
