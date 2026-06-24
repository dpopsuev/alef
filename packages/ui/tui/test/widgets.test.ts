import { describe, expect, it } from "vitest";
import { Box } from "../src/components/box.js";
import { ProgressBar } from "../src/components/progress-bar.js";
import { ScrollView } from "../src/components/scroll-view.js";
import { SplitPane } from "../src/components/split-pane.js";
import { Table } from "../src/components/table.js";
import { Text } from "../src/components/text.js";
import { ViModal } from "../src/vi-modal.js";

describe("Box", { tags: ["unit"] }, () => {
	it("renders with single border", () => {
		const box = new Box(new Text("hello"), { border: "single" });
		const lines = box.render(20);
		expect(lines[0]).toContain("┌");
		expect(lines[0]).toContain("┐");
		expect(lines[lines.length - 1]).toContain("└");
		expect(lines[lines.length - 1]).toContain("┘");
	});

	it("renders title in top border", () => {
		const box = new Box(new Text("content"), { border: "single", title: "Title" });
		const lines = box.render(30);
		expect(lines[0]).toContain("Title");
	});

	it("wraps child content", () => {
		const box = new Box(new Text("inner text"), { border: "single" });
		const lines = box.render(30);
		const contentLine = lines.find((l) => l.includes("inner text"));
		expect(contentLine).toBeDefined();
	});

	it("renders rounded borders", () => {
		const box = new Box(new Text("x"), { border: "rounded" });
		const lines = box.render(20);
		expect(lines[0]).toContain("╭");
		expect(lines[0]).toContain("╮");
	});
});

describe("ScrollView", { tags: ["unit"] }, () => {
	function tallContent(n: number) {
		return {
			render(_width: number) {
				return Array.from({ length: n }, (_, i) => `line ${i + 1}`);
			},
			invalidate() {},
		};
	}

	it("renders all lines when content fits", () => {
		const sv = new ScrollView(tallContent(5), { maxHeight: 10 });
		const lines = sv.render(40);
		expect(lines.length).toBe(5);
	});

	it("truncates to maxHeight when content overflows", () => {
		const sv = new ScrollView(tallContent(30), { maxHeight: 10 });
		const lines = sv.render(40);
		expect(lines.length).toBe(10);
	});

	it("scrolls down", () => {
		const sv = new ScrollView(tallContent(30), { maxHeight: 5, showScrollbar: false });
		sv.scrollDown(3);
		const lines = sv.render(40);
		expect(lines[0]).toContain("line 4");
	});

	it("scrolls to top with g", () => {
		const sv = new ScrollView(tallContent(30), { maxHeight: 5, showScrollbar: false });
		sv.scrollDown(10);
		sv.scrollToTop();
		const lines = sv.render(40);
		expect(lines[0]).toContain("line 1");
	});

	it("handles j/k input", () => {
		const sv = new ScrollView(tallContent(30), { maxHeight: 5, showScrollbar: false });
		expect(sv.handleInput("j")).toBe(true);
		expect(sv.handleInput("k")).toBe(true);
		expect(sv.handleInput("x")).toBe(false);
	});

	it("shows scrollbar when enabled", () => {
		const sv = new ScrollView(tallContent(30), { maxHeight: 5, showScrollbar: true });
		const lines = sv.render(40);
		const hasBar = lines.some((l) => l.includes("█") || l.includes("░"));
		expect(hasBar).toBe(true);
	});
});

describe("SplitPane", { tags: ["unit"] }, () => {
	it("renders two panes side by side", () => {
		const sp = new SplitPane(new Text("left"), new Text("right"), { ratio: 0.5 });
		const lines = sp.render(40);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines[0]).toContain("│");
	});

	it("falls back to left-only on narrow terminal", () => {
		const sp = new SplitPane(new Text("left"), new Text("right"), { minLeftWidth: 20, minRightWidth: 20 });
		const lines = sp.render(30);
		expect(lines[0]).not.toContain("│");
	});
});

describe("Table", { tags: ["unit"] }, () => {
	it("renders headers and rows", () => {
		const table = new Table({
			columns: [
				{ header: "Name", key: "name" },
				{ header: "Value", key: "value" },
			],
			rows: [
				{ name: "alpha", value: "1" },
				{ name: "beta", value: "2" },
			],
		});
		const lines = table.render(40);
		expect(lines[0]).toContain("Name");
		expect(lines[0]).toContain("Value");
		expect(lines[1]).toContain("─");
		expect(lines[2]).toContain("alpha");
		expect(lines[3]).toContain("beta");
	});

	it("renders separator between header and rows", () => {
		const table = new Table({
			columns: [{ header: "Col", key: "c" }],
			rows: [{ c: "val" }],
		});
		const lines = table.render(20);
		expect(lines[1]).toMatch(/─+/);
	});
});

describe("ProgressBar", { tags: ["unit"] }, () => {
	it("renders 0%", () => {
		const pb = new ProgressBar({ value: 0, max: 100 });
		const lines = pb.render(40);
		expect(lines[0]).toContain("0%");
	});

	it("renders 100%", () => {
		const pb = new ProgressBar({ value: 100, max: 100 });
		const lines = pb.render(40);
		expect(lines[0]).toContain("100%");
	});

	it("renders 50%", () => {
		const pb = new ProgressBar({ value: 50, max: 100 });
		const lines = pb.render(40);
		expect(lines[0]).toContain("50%");
		expect(lines[0]).toContain("█");
		expect(lines[0]).toContain("░");
	});

	it("includes label", () => {
		const pb = new ProgressBar({ value: 30, label: "Tokens" });
		const lines = pb.render(40);
		expect(lines[0]).toContain("Tokens");
	});
});

describe("ViModal", { tags: ["unit"] }, () => {
	it("starts in normal mode", () => {
		const vm = new ViModal();
		expect(vm.mode).toBe("normal");
		expect(vm.isNormal()).toBe(true);
	});

	it("i switches to insert mode", () => {
		const vm = new ViModal();
		expect(vm.handleKey("i")).toBe("mode-change");
		expect(vm.mode).toBe("insert");
	});

	it("/ switches to insert mode", () => {
		const vm = new ViModal();
		expect(vm.handleKey("/")).toBe("mode-change");
		expect(vm.isInsert()).toBe(true);
	});

	it("Esc in insert returns to normal", () => {
		const vm = new ViModal();
		vm.enterInsert();
		expect(vm.handleKey("\x1b")).toBe("mode-change");
		expect(vm.isNormal()).toBe(true);
	});

	it("calls onModeChange callback", () => {
		const changes: string[] = [];
		const vm = new ViModal({ onModeChange: (m) => changes.push(m) });
		vm.handleKey("i");
		vm.handleKey("\x1b");
		expect(changes).toEqual(["insert", "normal"]);
	});

	it("non-trigger keys pass through in normal mode", () => {
		const vm = new ViModal();
		expect(vm.handleKey("j")).toBe("passthrough");
		expect(vm.handleKey("k")).toBe("passthrough");
	});

	it("all keys pass through in insert mode except Esc", () => {
		const vm = new ViModal();
		vm.enterInsert();
		expect(vm.handleKey("a")).toBe("passthrough");
		expect(vm.handleKey("z")).toBe("passthrough");
		expect(vm.handleKey("\x1b")).toBe("mode-change");
	});

	it("supports custom insert triggers", () => {
		const vm = new ViModal({ insertTriggers: ["a", "s"] });
		expect(vm.handleKey("i")).toBe("passthrough");
		expect(vm.handleKey("a")).toBe("mode-change");
		expect(vm.isInsert()).toBe(true);
	});
});
