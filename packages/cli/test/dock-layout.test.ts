/**
 * Dock layout integrity tests.
 *
 * Assert line-by-line positioning of dock components: spinner, separator,
 * editor text, mode label, and footer. Catches regressions where streaming
 * LLM output bleeds into the dock zone or spinner/separator share a line.
 *
 * Uses VirtualTerminal (xterm.js headless) for accurate terminal emulation.
 * All tests use real timers + settle() because VirtualTerminal.flush()
 * requires real async callbacks.
 */

import { Container, Text, TUI } from "@dpopsuev/alef-tui";
import { describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../ui/tui/test/virtual-terminal.js";
import { PromptConsole } from "../src/client/console.js";
import { getTheme } from "../src/client/theme.js";

async function settle(ms = 30): Promise<void> {
	await new Promise<void>((r) => process.nextTick(r));
	await new Promise<void>((r) => setTimeout(r, ms));
}

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

function setup(width = 80, height = 24) {
	const terminal = new VirtualTerminal(width, height);
	const tui = new TUI(terminal);
	terminal.start(
		() => {},
		() => {},
	);
	tui.start();

	const chat = new Container();
	tui.addChild(chat);

	const pc = new PromptConsole(tui, getTheme(), "test-model");
	pc.mount();

	const footer = new Text("~/test (main)", 0, 0);
	tui.addChild(footer);

	return { terminal, tui, pc, chat, footer, cleanup: () => tui.stop() };
}

function findLines(viewport: string[], pred: (stripped: string) => boolean): number[] {
	return viewport.map((line, i) => (pred(stripAnsi(line)) ? i : -1)).filter((i) => i >= 0);
}

function assertOrder(...labels: { name: string; line: number }[]): void {
	for (let i = 1; i < labels.length; i++) {
		const prev = labels[i - 1]!;
		const curr = labels[i]!;
		expect(
			curr.line,
			`${curr.name} (line ${curr.line}) must be below ${prev.name} (line ${prev.line})`,
		).toBeGreaterThan(prev.line);
	}
}

const BRAILLE_RE = /[\u2800-\u28FF]/;
const SEPARATOR_RE = /[─\u2500]{3,}/;

describe("dock layout integrity", { tags: ["unit"] }, () => {
	it("spinner, separator, editor, mode label, and footer in correct order", async () => {
		const { terminal, tui, pc, chat, cleanup } = setup();

		for (let i = 0; i < 5; i++) chat.addChild(new Text(`chat message ${i}`, 0, 0));
		pc.startThinking();
		pc.setStatus("INSERT");
		pc.editor.setText("user prompt text");

		tui.requestRender(true);
		await settle(400);

		const viewport = await terminal.flushAndGetViewport();
		const stripped = viewport.map(stripAnsi);

		const spinnerLines = findLines(viewport, (s) => BRAILLE_RE.test(s));
		const separatorLines = findLines(viewport, (s) => SEPARATOR_RE.test(s.trim()));
		const editorLines = findLines(viewport, (s) => s.includes("user prompt text"));
		const insertLines = findLines(viewport, (s) => /INSERT/.test(s) && SEPARATOR_RE.test(s));
		const footerLines = findLines(viewport, (s) => s.includes("~/test"));

		expect(spinnerLines.length, `spinner not found:\n${stripped.join("\n")}`).toBeGreaterThanOrEqual(1);
		expect(separatorLines.length, `separator not found:\n${stripped.join("\n")}`).toBeGreaterThanOrEqual(1);
		expect(editorLines.length, `editor not found:\n${stripped.join("\n")}`).toBeGreaterThanOrEqual(1);
		expect(footerLines.length, `footer not found:\n${stripped.join("\n")}`).toBeGreaterThanOrEqual(1);

		for (const si of spinnerLines) {
			expect(separatorLines.includes(si), `spinner and separator share line ${si}: "${stripped[si]}"`).toBe(false);
		}

		assertOrder(
			{ name: "spinner", line: spinnerLines[0]! },
			{ name: "top-separator", line: separatorLines[0]! },
			{ name: "editor-text", line: editorLines[0]! },
			{ name: "INSERT", line: insertLines[0] ?? separatorLines[separatorLines.length - 1]! },
			{ name: "footer", line: footerLines[0]! },
		);

		pc.stopThinking();
		cleanup();
	});

	it("chat content does not bleed into the dock separator", async () => {
		const { terminal, tui, pc, chat, cleanup } = setup(80, 20);

		for (let i = 0; i < 30; i++) {
			chat.addChild(new Text(`streaming reply chunk ${i} with some content`, 0, 0));
		}
		pc.setStatus("INSERT");
		pc.editor.setText("prompt");

		tui.requestRender(true);
		await settle();

		const viewport = await terminal.flushAndGetViewport();
		const stripped = viewport.map(stripAnsi);

		const separatorLines = findLines(viewport, (s) => SEPARATOR_RE.test(s.trim()));
		expect(separatorLines.length, "should have separator lines").toBeGreaterThanOrEqual(1);

		for (const si of separatorLines) {
			const line = stripped[si]!;
			expect(line, `separator line ${si} contains chat text`).not.toMatch(/streaming reply chunk/);
		}

		const firstSep = separatorLines[0]!;
		for (let i = 0; i < firstSep; i++) {
			const line = stripped[i]!;
			if (line.trim().length > 0) {
				expect(line, `line ${i} above dock should be chat, not dock chrome`).not.toMatch(/INSERT|NORMAL/);
			}
		}

		cleanup();
	});

	it("spinner and agent card do not produce duplicate spinner lines", async () => {
		const { terminal, tui, pc, chat, cleanup } = setup(80, 20);

		for (let i = 0; i < 3; i++) chat.addChild(new Text(`msg ${i}`, 0, 0));
		pc.startThinking();
		pc.showInFlightCall("c1", "shell.exec", "npm test", { command: "npm test" });

		tui.requestRender(true);
		await settle(400);

		const viewport = await terminal.flushAndGetViewport();
		const stripped = viewport.map(stripAnsi);
		const brailleLines = findLines(viewport, (s) => BRAILLE_RE.test(s));

		expect(
			brailleLines.length,
			`expected at most 1 braille line, got ${brailleLines.length}:\n${brailleLines.map((i) => `  line ${i}: "${stripped[i]}"`).join("\n")}`,
		).toBeLessThanOrEqual(1);

		pc.removeInFlightCall("c1");
		pc.stopThinking();
		cleanup();
	});

	it("viewport bottom rows: separator, editor, mode, footer", async () => {
		const { terminal, tui, pc, chat, cleanup } = setup(80, 20);

		for (let i = 0; i < 3; i++) chat.addChild(new Text(`msg ${i}`, 0, 0));
		pc.setStatus("INSERT");
		pc.editor.setText("hello world");

		tui.requestRender(true);
		await settle();

		const viewport = await terminal.flushAndGetViewport();
		const stripped = viewport.map(stripAnsi);

		expect(stripped[stripped.length - 1], "bottom line should be footer").toContain("~/test");
		expect(stripped[stripped.length - 2], "second from bottom should have INSERT").toMatch(/INSERT/);
		expect(stripped[stripped.length - 2], "mode line should have separator chars").toMatch(SEPARATOR_RE);
		expect(stripped[stripped.length - 3], "third from bottom should be editor content").toContain("hello world");
		expect(stripped[stripped.length - 4], "fourth from bottom should be separator").toMatch(SEPARATOR_RE);

		cleanup();
	});

	it("scrollback above viewport contains only chat, not dock chrome", async () => {
		const { terminal, tui, chat, cleanup } = setup(72, 16);

		for (let i = 0; i < 40; i++) {
			chat.addChild(new Text(`chat-line-${i}`, 0, 0));
			tui.requestRender();
			await settle(15);
		}

		await terminal.flush();
		const scrollback = terminal.getScrollbackAboveViewport();

		const chatLines = scrollback.filter((l) => stripAnsi(l).includes("chat-line-"));
		expect(chatLines.length, "scrollback should contain archived chat").toBeGreaterThan(0);

		for (const line of scrollback) {
			const s = stripAnsi(line);
			if (s.trim().length === 0) continue;
			expect(s, "scrollback must not contain INSERT").not.toMatch(/INSERT|NORMAL/);
			expect(s, "scrollback must not be separator-only").not.toMatch(/^[─\u2500]{10,}$/);
		}

		cleanup();
	});

	it("topic label stays on the separator, not on a separate line", async () => {
		const { terminal, tui, pc, chat, cleanup } = setup();

		for (let i = 0; i < 3; i++) chat.addChild(new Text(`msg ${i}`, 0, 0));
		pc.setTopicLabel("my-topic");
		pc.editor.setText("test");

		tui.requestRender(true);
		await settle();

		const viewport = await terminal.flushAndGetViewport();
		const stripped = viewport.map(stripAnsi);

		const topicLines = findLines(viewport, (s) => s.includes("my-topic"));
		expect(topicLines.length, "topic label should appear").toBeGreaterThanOrEqual(1);

		for (const ti of topicLines) {
			expect(stripped[ti], `topic on line ${ti} should be on separator`).toMatch(SEPARATOR_RE);
		}

		cleanup();
	});

	it("during streaming, dock stays at the same viewport rows", async () => {
		const { terminal, tui, pc, chat, cleanup } = setup(80, 20);

		for (let i = 0; i < 5; i++) chat.addChild(new Text(`initial-${i}`, 0, 0));
		pc.startThinking();
		pc.setStatus("INSERT");
		pc.editor.setText("prompt");

		tui.requestRender(true);
		await settle();

		const viewportBefore = await terminal.flushAndGetViewport();
		const insertBefore = findLines(viewportBefore, (s) => /INSERT/.test(s) && SEPARATOR_RE.test(s));
		expect(insertBefore.length).toBeGreaterThanOrEqual(1);
		const insertRowBefore = insertBefore[0]!;

		for (let i = 0; i < 10; i++) {
			chat.addChild(new Text(`stream-${i}`, 0, 0));
			tui.requestRender();
			await settle(15);
		}

		const viewportAfter = await terminal.flushAndGetViewport();
		const insertAfter = findLines(viewportAfter, (s) => /INSERT/.test(s) && SEPARATOR_RE.test(s));
		expect(insertAfter.length, "INSERT line must still exist after streaming").toBeGreaterThanOrEqual(1);

		expect(
			insertAfter[0],
			`INSERT line moved from row ${insertRowBefore} to ${insertAfter[0]} during streaming`,
		).toBe(insertRowBefore);

		pc.stopThinking();
		cleanup();
	});
});
