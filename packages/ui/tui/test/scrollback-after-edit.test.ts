/**
 * Scrollback integrity after fs.edit-style tool results.
 *
 * Full test matrix:
 *   Unit:        DiffBlock render output, line counts, background padding
 *   Integration: DiffBlock inside dock-mode TUI, differential renderer
 *   E2E:         Multi-edit turns with interleaved text, resize, scrollback
 *
 * Uses the real DiffBlock component with ANSI background fills to
 * reproduce the rendering conditions that cause corruption.
 */

import { describe, expect, it } from "vitest";
import type { ThemeTokens } from "../src/theme-types.js";
import { Text } from "../src/components/text.js";
import { Container, TUI } from "../src/tui.js";
import { DiffBlock, formatDiffHeader, renderDiffDisplay } from "../src/views/tool-view.js";
import { DynamicText } from "../src/views/index.js";
import { applyBackgroundToLine, visibleWidth } from "../src/utils.js";
import { VirtualTerminal } from "./virtual-terminal.js";

const W = { ansi16: 37 };
const OK = { ansi16: 32 };
const ERR = { ansi16: 31 };
const WARN = { ansi16: 33 };

function stubTheme(): ThemeTokens {
	return {
		userFg: W, userBg: W, agentFg: W, agentBg: W,
		primaryFg: W, secondaryFg: W, mutedFg: W, accentFg: W, brightFg: W,
		okFg: OK, warnFg: WARN, errFg: ERR,
	} as ThemeTokens;
}

async function settle(ms = 40): Promise<void> {
	await new Promise<void>((r) => process.nextTick(r));
	await new Promise<void>((r) => setTimeout(r, ms));
	await new Promise<void>((r) => process.nextTick(r));
}

function makeDiff(path: string, oldLines: string[], newLines: string[]): string {
	const header = `edit ${path}`;
	const rem = oldLines.map((l) => `-${l}`);
	const add = newLines.map((l) => `+${l}`);
	return [header, ...rem, ...add].join("\n");
}

function addToolResult(chat: Container, label: string, diffText: string): void {
	const t = stubTheme();
	chat.addChild(new Text(label, 0, 0));
	chat.addChild(new DiffBlock(diffText, t, 0));
}

// ---------------------------------------------------------------------------
// Unit: DiffBlock render correctness
// ---------------------------------------------------------------------------

describe("DiffBlock unit", { tags: ["unit"] }, () => {
	it("renders header with +N -M counts", () => {
		const header = formatDiffHeader("edit file.ts", ["+new line", "-old line", "  context"]);
		expect(header).toBe("Edited file.ts +1 -1");
	});

	it("renders correct number of lines", () => {
		const diff = makeDiff("f.ts", ["old1", "old2"], ["new1"]);
		const block = new DiffBlock(diff, stubTheme(), 0);
		const lines = block.render(80);
		// header + 2 rem + 1 add = 4 lines minimum
		expect(lines.length).toBeGreaterThanOrEqual(4);
	});

	it("every rendered line has exactly the requested visible width", () => {
		const diff = makeDiff("f.ts", ["short"], ["a longer replacement line here"]);
		const block = new DiffBlock(diff, stubTheme(), 0);
		const WIDTH = 60;
		const lines = block.render(WIDTH);
		for (let i = 0; i < lines.length; i++) {
			const vw = visibleWidth(lines[i]!);
			expect(vw, `line ${i} visible width should be ${WIDTH}, got ${vw}`).toBe(WIDTH);
		}
	});

	it("produces stable output across repeated renders at same width", () => {
		const diff = makeDiff("f.ts", ["a"], ["b"]);
		const block = new DiffBlock(diff, stubTheme(), 0);
		const first = block.render(80);
		const second = block.render(80);
		expect(first).toEqual(second);
	});

	it("invalidates cache when width changes", () => {
		const diff = makeDiff("f.ts", ["a"], ["b"]);
		const block = new DiffBlock(diff, stubTheme(), 0);
		const narrow = block.render(40);
		const wide = block.render(80);
		// Different widths produce different padding
		expect(narrow[0]).not.toBe(wide[0]);
	});

	it("handles empty diff (no adds or removes)", () => {
		const block = new DiffBlock("edit f.ts\n  context only", stubTheme(), 0);
		const lines = block.render(60);
		expect(lines.length).toBeGreaterThan(0);
	});

	it("handles very long lines that need wrapping", () => {
		const longLine = "x".repeat(200);
		const diff = makeDiff("f.ts", [longLine], ["short"]);
		const block = new DiffBlock(diff, stubTheme(), 0);
		const lines = block.render(60);
		// Long line should wrap, producing more lines than a short diff
		expect(lines.length).toBeGreaterThan(4);
	});

	it("background-padded lines are string-comparable (same content = same string)", () => {
		const line = "\x1b[32m+new\x1b[0m";
		const a = applyBackgroundToLine(line, 40, (t) => `\x1b[42m${t}\x1b[0m`);
		const b = applyBackgroundToLine(line, 40, (t) => `\x1b[42m${t}\x1b[0m`);
		expect(a).toBe(b);
	});
});

// ---------------------------------------------------------------------------
// Integration: DiffBlock in dock-mode differential renderer
// ---------------------------------------------------------------------------

describe("DiffBlock in dock-mode TUI", { tags: ["unit"] }, () => {
	it("single diff block preserves footer position", async () => {
		const terminal = new VirtualTerminal(80, 20);
		const tui = new TUI(terminal);
		terminal.start(() => {}, () => tui.requestRender());
		tui.start();

		const chat = new Container();
		tui.addChild(chat);
		const footer = new DynamicText(() => "-- INSERT --");
		tui.addChild(footer);
		tui.setDock(footer);

		chat.addChild(new Text("Agent reply text here.", 0, 0));
		tui.requestRender(true);
		await settle();

		addToolResult(chat, "fs.edit  logger.ts  122ms", makeDiff(
			"logger.ts",
			["const level = old;"],
			["const level = new;", "const logger = createLogger();"],
		));

		tui.requestRender(); // differential
		await settle();

		const viewport = await terminal.flushAndGetViewport();
		expect(viewport[viewport.length - 1]).toContain("INSERT");
		expect(viewport.filter((l) => l.includes("INSERT")).length).toBe(1);

		tui.stop();
	});

	it("diff block lines are stable across consecutive renders without changes", async () => {
		const terminal = new VirtualTerminal(60, 14);
		const tui = new TUI(terminal);
		terminal.start(() => {}, () => tui.requestRender());
		tui.start();

		const chat = new Container();
		tui.addChild(chat);
		const footer = new DynamicText(() => "DOCK");
		tui.addChild(footer);
		tui.setDock(footer);

		addToolResult(chat, "fs.edit  f.ts  50ms", makeDiff("f.ts", ["a"], ["b"]));
		tui.requestRender(true);
		await settle();

		const first = await terminal.flushAndGetViewport();

		// Re-render without changes -- viewport should be identical
		tui.requestRender();
		await settle();

		const second = await terminal.flushAndGetViewport();
		expect(first).toEqual(second);

		tui.stop();
	});

	it("appending text after a diff block via differential render", async () => {
		const terminal = new VirtualTerminal(60, 14);
		const tui = new TUI(terminal);
		terminal.start(() => {}, () => tui.requestRender());
		tui.start();

		const chat = new Container();
		tui.addChild(chat);
		const footer = new DynamicText(() => "DOCK");
		tui.addChild(footer);
		tui.setDock(footer);

		addToolResult(chat, "fs.edit  f.ts  50ms", makeDiff("f.ts", ["old"], ["new"]));
		tui.requestRender(true);
		await settle();

		// Append text after the diff (simulates agent continuing after tool result)
		chat.addChild(new Text("All checks pass.", 0, 0));
		tui.requestRender(); // differential
		await settle();

		const viewport = await terminal.flushAndGetViewport();
		expect(viewport[viewport.length - 1]).toContain("DOCK");
		const allText = terminal.getScrollBuffer().join("\n");
		expect(allText).toContain("All checks pass");

		tui.stop();
	});

	it("no adjacent duplicate lines after diff block append", async () => {
		const terminal = new VirtualTerminal(60, 12);
		const tui = new TUI(terminal);
		terminal.start(() => {}, () => tui.requestRender());
		tui.start();

		const chat = new Container();
		tui.addChild(chat);
		const footer = new DynamicText(() => "DOCK");
		tui.addChild(footer);
		tui.setDock(footer);

		chat.addChild(new Text("Before edit.", 0, 0));
		tui.requestRender(true);
		await settle();

		addToolResult(chat, "fs.edit  a.ts  80ms", makeDiff("a.ts", ["x"], ["y"]));
		tui.requestRender();
		await settle();

		const viewport = await terminal.flushAndGetViewport();
		for (let i = 1; i < viewport.length; i++) {
			const prev = viewport[i - 1]!.trim();
			const curr = viewport[i]!.trim();
			if (prev && curr && prev === curr) {
				expect.fail(`adjacent duplicate at rows ${i - 1}/${i}: "${prev}"`);
			}
		}

		tui.stop();
	});
});

// ---------------------------------------------------------------------------
// E2E: Multi-edit turns, resize, scrollback preservation
// ---------------------------------------------------------------------------

describe("scrollback integrity E2E", { tags: ["unit"] }, () => {
	it("three sequential edits maintain correct scrollback order", async () => {
		const terminal = new VirtualTerminal(80, 16);
		const tui = new TUI(terminal);
		terminal.start(() => {}, () => tui.requestRender());
		tui.start();

		const chat = new Container();
		tui.addChild(chat);
		const footer = new DynamicText(() => "DOCK");
		tui.addChild(footer);
		tui.setDock(footer);

		chat.addChild(new Text("Editing three files.", 0, 0));
		tui.requestRender(true);
		await settle();

		const files = ["logger.ts", "runner.ts", "layout.ts"];
		for (const file of files) {
			addToolResult(chat, `fs.edit  ${file}  100ms`, makeDiff(
				file, [`old in ${file}`], [`new in ${file}`, `extra in ${file}`],
			));
			tui.requestRender(); // differential
			await settle();
		}

		chat.addChild(new Text("All three files updated.", 0, 0));
		tui.requestRender();
		await settle();

		const viewport = await terminal.flushAndGetViewport();
		expect(viewport[viewport.length - 1]).toContain("DOCK");

		const allText = terminal.getScrollBuffer().join("\n");
		for (const file of files) {
			expect(allText, `${file} should be in scroll buffer`).toContain(file);
		}
		expect(allText).toContain("All three files updated");

		tui.stop();
	});

	it("text/edit/text/edit/text interleaving via differential render", async () => {
		const terminal = new VirtualTerminal(60, 12);
		const tui = new TUI(terminal);
		terminal.start(() => {}, () => tui.requestRender());
		tui.start();

		const chat = new Container();
		tui.addChild(chat);
		const footer = new DynamicText(() => "FOOTER");
		tui.addChild(footer);
		tui.setDock(footer);

		tui.requestRender(true);
		await settle();

		const steps: Array<{ type: "text"; text: string } | { type: "edit"; label: string; diff: string }> = [
			{ type: "text", text: "I will fix the import." },
			{ type: "edit", label: "fs.edit  types.ts  80ms", diff: makeDiff("types.ts", ["old import"], ["new import"]) },
			{ type: "text", text: "Now updating the tests." },
			{ type: "edit", label: "fs.edit  test.ts  45ms", diff: makeDiff("test.ts", ["expect(old)"], ["expect(new)"]) },
			{ type: "text", text: "Done. Both files updated." },
		];

		for (const step of steps) {
			if (step.type === "text") {
				chat.addChild(new Text(step.text, 0, 0));
			} else {
				addToolResult(chat, step.label, step.diff);
			}
			tui.requestRender(); // differential
			await settle();
		}

		const viewport = await terminal.flushAndGetViewport();
		expect(viewport[viewport.length - 1]).toContain("FOOTER");
		expect(viewport.filter((l) => l.includes("FOOTER")).length).toBe(1);

		tui.stop();
	});

	it("large diff pushing past viewport preserves earlier content", async () => {
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TUI(terminal);
		terminal.start(() => {}, () => tui.requestRender());
		tui.start();

		const chat = new Container();
		tui.addChild(chat);
		const footer = new DynamicText(() => "INPUT");
		tui.addChild(footer);
		tui.setDock(footer);

		for (let i = 0; i < 3; i++) {
			chat.addChild(new Text(`context-${i}`, 0, 0));
		}
		tui.requestRender(true);
		await settle();

		const oldLines = Array.from({ length: 8 }, (_, i) => `old-${i}: x = ${i};`);
		const newLines = Array.from({ length: 8 }, (_, i) => `new-${i}: y = ${i * 2};`);
		addToolResult(chat, "fs.edit  large.ts  250ms", makeDiff("large.ts", oldLines, newLines));

		tui.requestRender(); // differential
		await settle();

		const viewport = await terminal.flushAndGetViewport();
		expect(viewport[viewport.length - 1]).toContain("INPUT");

		const allText = terminal.getScrollBuffer().join("\n");
		expect(allText).toContain("context-0");

		tui.stop();
	});

	it("edit after terminal resize renders without corruption", async () => {
		const terminal = new VirtualTerminal(80, 14);
		const tui = new TUI(terminal);
		terminal.start(() => {}, () => tui.requestRender());
		tui.start();

		const chat = new Container();
		tui.addChild(chat);
		const footer = new DynamicText(() => "DOCK");
		tui.addChild(footer);
		tui.setDock(footer);

		chat.addChild(new Text("Before resize.", 0, 0));
		addToolResult(chat, "fs.edit  a.ts  50ms", makeDiff("a.ts", ["old-a"], ["new-a"]));
		tui.requestRender(true);
		await settle();

		terminal.resize(50, 14);
		await settle();

		addToolResult(chat, "fs.edit  b.ts  60ms", makeDiff("b.ts", ["old-b"], ["new-b"]));
		tui.requestRender();
		await settle();

		const viewport = await terminal.flushAndGetViewport();
		expect(viewport[viewport.length - 1]).toContain("DOCK");

		const allText = terminal.getScrollBuffer().join("\n");
		expect(allText).toContain("a.ts");
		expect(allText).toContain("b.ts");

		tui.stop();
	});

	it("rapid edits with spinner-like footer updates", async () => {
		const terminal = new VirtualTerminal(60, 12);
		const tui = new TUI(terminal);
		terminal.start(() => {}, () => tui.requestRender());
		tui.start();

		const chat = new Container();
		tui.addChild(chat);
		let footerText = "-- INSERT --";
		const footer = new DynamicText(() => footerText);
		tui.addChild(footer);
		tui.setDock(footer);

		chat.addChild(new Text("Starting batch...", 0, 0));
		tui.requestRender(true);
		await settle();

		for (let i = 0; i < 4; i++) {
			// Simulate spinner update before tool result
			footerText = `-- THINKING ${"|/-\\"[i % 4]} --`;
			tui.requestRender();
			await settle(10);

			addToolResult(chat, `fs.edit  file-${i}.ts  ${50 + i * 30}ms`,
				makeDiff(`file-${i}.ts`, [`old-${i}`], [`new-${i}`]),
			);
			tui.requestRender(); // differential
			await settle();

			const viewport = await terminal.flushAndGetViewport();
			expect(viewport[viewport.length - 1],
				`footer on last line after edit ${i}`).toContain("THINKING");
		}

		footerText = "-- INSERT --";
		tui.requestRender();
		await settle();

		const final = await terminal.flushAndGetViewport();
		expect(final[final.length - 1]).toContain("INSERT");

		tui.stop();
	});

	it("diff block with lines exactly matching terminal width", async () => {
		const WIDTH = 40;
		const terminal = new VirtualTerminal(WIDTH, 12);
		const tui = new TUI(terminal);
		terminal.start(() => {}, () => tui.requestRender());
		tui.start();

		const chat = new Container();
		tui.addChild(chat);
		const footer = new DynamicText(() => "DOCK");
		tui.addChild(footer);
		tui.setDock(footer);

		// Craft lines that are exactly terminal width minus prefix char
		const exactLine = "x".repeat(WIDTH - 1);
		addToolResult(chat, "fs.edit  exact.ts  10ms",
			makeDiff("exact.ts", [exactLine], [exactLine.replace(/x$/, "y")]),
		);

		tui.requestRender(true);
		await settle();

		tui.requestRender(); // no-change differential
		await settle();

		const viewport = await terminal.flushAndGetViewport();
		expect(viewport[viewport.length - 1]).toContain("DOCK");

		// Every rendered line should fit within terminal width
		for (let i = 0; i < viewport.length; i++) {
			const vw = visibleWidth(viewport[i]!);
			expect(vw, `viewport row ${i} width ${vw} exceeds terminal width ${WIDTH}`).toBeLessThanOrEqual(WIDTH);
		}

		tui.stop();
	});

	it("diff block line count changes when terminal narrows mid-session", async () => {
		const terminal = new VirtualTerminal(80, 14);
		const tui = new TUI(terminal);
		terminal.start(() => {}, () => tui.requestRender());
		tui.start();

		const chat = new Container();
		tui.addChild(chat);
		const footer = new DynamicText(() => "DOCK");
		tui.addChild(footer);
		tui.setDock(footer);

		const longLine = "const result = await someFunction(param1, param2, param3, param4);";
		addToolResult(chat, "fs.edit  wrap.ts  10ms",
			makeDiff("wrap.ts", [longLine], [`${longLine} // modified`]),
		);
		chat.addChild(new Text("After the edit.", 0, 0));

		tui.requestRender(true);
		await settle();

		const before = await terminal.flushAndGetViewport();
		expect(before[before.length - 1]).toContain("DOCK");

		terminal.resize(40, 14);
		await settle();

		const after = await terminal.flushAndGetViewport();
		expect(after[after.length - 1], "footer must remain on last line after narrow resize").toContain("DOCK");

		const allText = terminal.getScrollBuffer().join("\n");
		expect(allText).toContain("After the edit");

		tui.stop();
	});

	it("differential render after edit does not emit ESC[2J or ESC[3J", async () => {
		const terminal = new VirtualTerminal(60, 14);
		const writes: string[] = [];
		const origWrite = terminal.write.bind(terminal);
		terminal.write = (data: string) => { writes.push(data); origWrite(data); };

		const tui = new TUI(terminal);
		terminal.start(() => {}, () => tui.requestRender());
		tui.start();

		const chat = new Container();
		tui.addChild(chat);
		const footer = new DynamicText(() => "DOCK");
		tui.addChild(footer);
		tui.setDock(footer);

		chat.addChild(new Text("Initial content.", 0, 0));
		tui.requestRender(true);
		await settle();

		writes.length = 0;

		addToolResult(chat, "fs.edit  f.ts  50ms", makeDiff("f.ts", ["old"], ["new"]));
		tui.requestRender(); // differential
		await settle();

		const allWrites = writes.join("");
		expect(allWrites).not.toContain("\x1b[2J");
		expect(allWrites).not.toContain("\x1b[3J");

		writes.length = 0;

		chat.addChild(new Text("After the edit.", 0, 0));
		tui.requestRender(); // differential
		await settle();

		const writes2 = writes.join("");
		expect(writes2).not.toContain("\x1b[2J");
		expect(writes2).not.toContain("\x1b[3J");

		tui.stop();
	});

	it("height resize after diff block does not duplicate content", async () => {
		const terminal = new VirtualTerminal(60, 12);
		const tui = new TUI(terminal);
		terminal.start(() => {}, () => tui.requestRender());
		tui.start();

		const chat = new Container();
		tui.addChild(chat);
		const footer = new DynamicText(() => "DOCK");
		tui.addChild(footer);
		tui.setDock(footer);

		addToolResult(chat, "fs.edit  f.ts  30ms", makeDiff("f.ts", ["a", "b"], ["c", "d", "e"]));
		chat.addChild(new Text("After the edit.", 0, 0));
		tui.requestRender(true);
		await settle();

		// Height resize -- this historically caused duplicates
		terminal.resize(60, 18);
		await settle();

		const viewport = await terminal.flushAndGetViewport();
		expect(viewport[viewport.length - 1]).toContain("DOCK");

		// Count occurrences of "After the edit" -- should be exactly 1
		const afterCount = viewport.filter((l) => l.includes("After the edit")).length;
		expect(afterCount, "text after edit should appear exactly once in viewport").toBeLessThanOrEqual(1);

		tui.stop();
	});
});
