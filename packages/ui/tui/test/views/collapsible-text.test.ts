import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { CollapsibleText } from "../../src/components/collapsible-text.js";
import { Markdown } from "../../src/components/markdown.js";
import { DiffBlock, makeToolOutputComponent } from "../../src/views/index.js";

const W = { ansi16: 37 };
const OK = { ansi16: 32 };
const ERR = { ansi16: 31 };
const WARN = { ansi16: 33 };
function getTheme() {
	return {
		userFg: W,
		userBg: W,
		agentFg: W,
		agentBg: W,
		primaryFg: W,
		secondaryFg: W,
		mutedFg: W,
		accentFg: W,
		brightFg: W,
		okFg: OK,
		warnFg: WARN,
		errFg: ERR,
	};
}

describe("CollapsibleText", () => {
	it("renders short output inline without header", () => {
		const ct = new CollapsibleText({ text: "line1\nline2\nline3" });
		const lines = ct.render(80);
		const plain = lines.map((l) => stripVTControlCharacters(l));
		expect(plain).toEqual(["line1", "line2", "line3"]);
		expect(ct.isLong).toBe(false);
	});

	it("renders exactly 5 lines inline without header", () => {
		const text = Array.from({ length: 5 }, (_, i) => `line${i + 1}`).join("\n");
		const ct = new CollapsibleText({ text });
		const lines = ct.render(80);
		expect(lines).toHaveLength(5);
		expect(ct.isLong).toBe(false);
	});

	it("renders 6+ lines collapsed with header showing line count", () => {
		const text = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n");
		const ct = new CollapsibleText({ text });
		expect(ct.isLong).toBe(true);
		expect(ct.collapsed).toBe(true);

		const lines = ct.render(80);
		const plain = lines.map((l) => stripVTControlCharacters(l));
		// Header + 5 collapsed lines = 6 total
		expect(plain).toHaveLength(6);
		expect(plain[0]).toContain("10 lines");
		expect(plain[0]).toContain("+5 hidden");
		expect(plain[1]).toBe("line1");
		expect(plain[5]).toBe("line5");
	});

	it("expands to show all lines", () => {
		const text = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n");
		const ct = new CollapsibleText({ text });
		ct.expand();
		expect(ct.collapsed).toBe(false);

		const lines = ct.render(80);
		const plain = lines.map((l) => stripVTControlCharacters(l));
		// Header + 10 lines = 11 total
		expect(plain).toHaveLength(11);
		expect(plain[0]).toContain("10 lines");
		expect(plain[0]).not.toContain("hidden");
		expect(plain[10]).toBe("line10");
	});

	it("toggle switches between collapsed and expanded", () => {
		const text = Array.from({ length: 8 }, (_, i) => `line${i + 1}`).join("\n");
		const ct = new CollapsibleText({ text });
		expect(ct.collapsed).toBe(true);
		ct.toggle();
		expect(ct.collapsed).toBe(false);
		ct.toggle();
		expect(ct.collapsed).toBe(true);
	});

	it("applies paddingX to all lines", () => {
		const ct = new CollapsibleText({ text: "a\nb\nc", paddingX: 4 });
		const lines = ct.render(80);
		for (const line of lines) {
			expect(line).toMatch(/^    /);
		}
	});

	it("applies headerStyle and textStyle", () => {
		let headerCalled = false;
		let textCalled = false;
		const ct = new CollapsibleText({
			text: Array.from({ length: 8 }, (_, i) => `L${i}`).join("\n"),
			headerStyle: (s) => {
				headerCalled = true;
				return `[H]${s}`;
			},
			textStyle: (s) => {
				textCalled = true;
				return `[T]${s}`;
			},
		});
		const lines = ct.render(80);
		expect(headerCalled).toBe(true);
		expect(textCalled).toBe(true);
		expect(lines[0]).toContain("[H]");
		expect(lines[1]).toContain("[T]");
	});
});

describe("makeToolOutputComponent with text/plain", () => {
	it("returns CollapsibleText for text/plain displayKind", () => {
		const comp = makeToolOutputComponent("hello world", "text/plain", getTheme());
		expect(comp).toBeInstanceOf(CollapsibleText);
	});

	it("short text/plain output renders inline", () => {
		const comp = makeToolOutputComponent("hello\nworld", "text/plain", getTheme());
		const lines = comp.render(80);
		const plain = lines.map((l) => stripVTControlCharacters(l));
		expect(plain).toContain("hello");
		expect(plain).toContain("world");
	});

	it("long text/plain output renders collapsed", () => {
		const text = Array.from({ length: 20 }, (_, i) => `output line ${i + 1}`).join("\n");
		const comp = makeToolOutputComponent(text, "text/plain", getTheme());
		expect(comp).toBeInstanceOf(CollapsibleText);
		const ct = comp as CollapsibleText;
		expect(ct.isLong).toBe(true);
		expect(ct.collapsed).toBe(true);
		const lines = ct.render(80);
		// Header + 5 collapsed lines
		expect(lines).toHaveLength(6);
	});

	it("does not affect text/x-diff routing", () => {
		const comp = makeToolOutputComponent("edit foo.ts\n+added", "text/x-diff", getTheme());
		expect(comp).toBeInstanceOf(DiffBlock);
	});

	it("does not affect text/markdown routing", () => {
		const comp = makeToolOutputComponent("# Hello", "text/markdown", getTheme());
		expect(comp).toBeInstanceOf(Markdown);
	});
});
