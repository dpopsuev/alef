/**
 * Scrollback integrity after fs.edit-style tool results.
 *
 * Simulates the real TUI flow: agent reply text in scrollback,
 * then tool-start/tool-end with a DiffBlock (text/x-diff), then
 * more reply text. Verifies the viewport and scrollback stay intact
 * across multiple differential renders.
 *
 * Uses the real DiffBlock component with ANSI background fills to
 * reproduce the rendering conditions that cause corruption.
 */

import { describe, expect, it } from "vitest";
import type { ThemeTokens } from "../src/theme-types.js";
import { Text } from "../src/components/text.js";
import { Container, TUI } from "../src/tui.js";
import { DiffBlock } from "../src/views/tool-view.js";
import { DynamicText } from "../src/views/index.js";
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

/** Simulates what appendCompletedToolBlock + DiffBlock produce for an fs.edit result. */
function addToolResult(
	chat: Container,
	toolLabel: string,
	diffText: string,
	width: number,
): void {
	const t = stubTheme();
	chat.addChild(new Text(toolLabel, 0, 0));
	const diffBlock = new DiffBlock(diffText, t, 0);
	chat.addChild(diffBlock);
}

/** Build a realistic diff string like fs.edit produces. */
function makeDiff(path: string, oldLines: string[], newLines: string[]): string {
	const header = `edit ${path} +${newLines.length} -${oldLines.length}`;
	const rem = oldLines.map((l) => `-${l}`);
	const add = newLines.map((l) => `+${l}`);
	const ctx = ["     ...", `  ${oldLines.length + newLines.length + 2} lines`];
	return [header, ...ctx.slice(0, 1), ...rem, ...add, ...ctx.slice(1)].join("\n");
}

describe("scrollback integrity after fs.edit", { tags: ["unit"] }, () => {
	it("single edit result preserves viewport structure", async () => {
		const terminal = new VirtualTerminal(80, 20);
		const tui = new TUI(terminal);
		terminal.start(() => {}, () => tui.requestRender());
		tui.start();

		const chat = new Container();
		tui.addChild(chat);

		const footer = new DynamicText(() => "-- INSERT --");
		tui.addChild(footer);
		tui.setDock(footer);

		// Agent reply text
		chat.addChild(new Text("The fix is straightforward. Let me edit the file.", 0, 0));

		tui.requestRender(true);
		await settle();

		// Tool result arrives
		addToolResult(chat, "fs.edit  packages/cli/src/boot/logger.ts  122ms", makeDiff(
			"packages/cli/src/boot/logger.ts",
			["const level = willUseTui && !debug ? 'silent' : resolveLevel(debug);"],
			["const level = willUseTui ? 'silent' : resolveLevel(debug);", "const logger = createLogger(level, willUseTui);"],
		), 80);

		tui.requestRender(); // differential
		await settle();

		const viewport = await terminal.flushAndGetViewport();

		// Footer must be on the last line
		expect(viewport[viewport.length - 1]).toContain("INSERT");

		// Footer appears exactly once
		const footerCount = viewport.filter((l) => l.includes("INSERT")).length;
		expect(footerCount, "footer must appear exactly once").toBe(1);

		// The diff header should be visible
		const allText = terminal.getScrollBuffer().join("\n");
		expect(allText).toContain("logger.ts");

		tui.stop();
	});

	it("multiple sequential edit results maintain scrollback order", async () => {
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
				file,
				[`old line in ${file}`],
				[`new line in ${file}`, `another new line in ${file}`],
			), 80);
			tui.requestRender(); // differential each time
			await settle();
		}

		// Add more text after all edits
		chat.addChild(new Text("All three files updated.", 0, 0));
		tui.requestRender();
		await settle();

		const viewport = await terminal.flushAndGetViewport();
		expect(viewport[viewport.length - 1]).toContain("DOCK");

		// All edit results should be in the scroll buffer
		const allText = terminal.getScrollBuffer().join("\n");
		for (const file of files) {
			expect(allText, `${file} should be in scroll buffer`).toContain(file);
		}
		expect(allText).toContain("All three files updated");

		// No adjacent duplicate lines in viewport (corruption signal)
		for (let i = 1; i < viewport.length; i++) {
			const prev = viewport[i - 1]!.trim();
			const curr = viewport[i]!.trim();
			if (prev && curr && prev === curr) {
				expect.fail(`adjacent duplicate at rows ${i - 1}/${i}: "${prev}"`);
			}
		}

		tui.stop();
	});

	it("edit result interleaved with agent text does not corrupt viewport", async () => {
		const terminal = new VirtualTerminal(60, 12);
		const tui = new TUI(terminal);
		terminal.start(() => {}, () => tui.requestRender());
		tui.start();

		const chat = new Container();
		tui.addChild(chat);
		const footer = new DynamicText(() => "FOOTER");
		tui.addChild(footer);
		tui.setDock(footer);

		// Simulate a real turn: text -> edit -> text -> edit -> text
		const sequence = [
			{ type: "text", content: "I will fix the import." },
			{
				type: "edit",
				label: "fs.edit  boot-types.ts  80ms",
				diff: makeDiff("boot-types.ts", ["import { X } from 'old';"], ["import { X } from 'new';"]),
			},
			{ type: "text", content: "Now updating the tests." },
			{
				type: "edit",
				label: "fs.edit  boot-types.test.ts  45ms",
				diff: makeDiff("boot-types.test.ts", ["expect(old).toBe(true);"], ["expect(updated).toBe(true);"]),
			},
			{ type: "text", content: "Done. Both files updated." },
		];

		tui.requestRender(true);
		await settle();

		for (const step of sequence) {
			if (step.type === "text") {
				chat.addChild(new Text(step.content!, 0, 0));
			} else {
				addToolResult(chat, step.label!, step.diff!, 60);
			}
			tui.requestRender(); // differential
			await settle();
		}

		const viewport = await terminal.flushAndGetViewport();
		expect(viewport[viewport.length - 1]).toContain("FOOTER");

		const footerCount = viewport.filter((l) => l.includes("FOOTER")).length;
		expect(footerCount).toBe(1);

		const allText = terminal.getScrollBuffer().join("\n");
		expect(allText).toContain("Done. Both files updated");

		tui.stop();
	});

	it("large diff result pushing past viewport preserves scrollback", async () => {
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TUI(terminal);
		terminal.start(() => {}, () => tui.requestRender());
		tui.start();

		const chat = new Container();
		tui.addChild(chat);
		const footer = new DynamicText(() => "INPUT");
		tui.addChild(footer);
		tui.setDock(footer);

		// Pre-fill with some context
		for (let i = 0; i < 3; i++) {
			chat.addChild(new Text(`context-line-${i}`, 0, 0));
		}
		tui.requestRender(true);
		await settle();

		// Large diff: more lines than the viewport
		const oldLines = Array.from({ length: 8 }, (_, i) => `old-${i}: const x = ${i};`);
		const newLines = Array.from({ length: 8 }, (_, i) => `new-${i}: const y = ${i * 2};`);
		addToolResult(chat, "fs.edit  large-file.ts  250ms", makeDiff("large-file.ts", oldLines, newLines), 80);

		tui.requestRender(); // differential
		await settle();

		const viewport = await terminal.flushAndGetViewport();
		expect(viewport[viewport.length - 1]).toContain("INPUT");

		// Context lines should be in scrollback (pushed up by the large diff)
		const allText = terminal.getScrollBuffer().join("\n");
		expect(allText).toContain("context-line-0");

		tui.stop();
	});

	it("edit result after terminal width change renders correctly", async () => {
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
		addToolResult(chat, "fs.edit  file-a.ts  50ms", makeDiff("file-a.ts", ["old-a"], ["new-a"]), 80);

		tui.requestRender(true);
		await settle();

		// Resize (DiffBlock cache invalidates via width change)
		terminal.resize(60, 14);
		await settle();

		// Add another edit at the new width
		addToolResult(chat, "fs.edit  file-b.ts  60ms", makeDiff("file-b.ts", ["old-b"], ["new-b"]), 60);
		tui.requestRender();
		await settle();

		const viewport = await terminal.flushAndGetViewport();
		expect(viewport[viewport.length - 1]).toContain("DOCK");

		const allText = terminal.getScrollBuffer().join("\n");
		expect(allText).toContain("file-a.ts");
		expect(allText).toContain("file-b.ts");

		tui.stop();
	});
});
