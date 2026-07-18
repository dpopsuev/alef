import { describe, expect, it } from "vitest";
import { SeparatorLine } from "../../src/components/separator-line.js";
import { visibleWidth } from "../../src/utils.js";

describe("SeparatorLine dual labels", { tags: ["unit"] }, () => {
	it("keeps left mode label and right notice on the same rule", () => {
		const line = new SeparatorLine();
		line.setLeftLabel("INSERT");
		line.setRightLabel("Compacting context...");
		const rendered = line.render(60)[0]!;
		expect(rendered.startsWith("─ INSERT ")).toBe(true);
		expect(rendered).toContain(" Compacting context... ");
		expect(rendered.indexOf("INSERT")).toBeLessThan(rendered.indexOf("Compacting"));
		expect(rendered.endsWith("─")).toBe(true);
	});

	it("mode-only stays left-aligned without a right notice", () => {
		const line = new SeparatorLine();
		line.setLeftLabel("NORMAL");
		const rendered = line.render(40)[0]!;
		expect(rendered.startsWith("─ NORMAL ")).toBe(true);
		expect(rendered.endsWith("─")).toBe(true);
	});

	it("clearing the right notice restores mode-only layout", () => {
		const line = new SeparatorLine();
		line.setLeftLabel("INSERT");
		line.setRightLabel("compacted 10 turns, recovered ~5k tokens");
		line.setRightLabel("");
		const rendered = line.render(40)[0]!;
		expect(rendered).toContain("INSERT");
		expect(rendered).not.toContain("compacted");
	});
});

describe("SeparatorLine right-aligned topic title", { tags: ["unit"] }, () => {
	it("keeps at least one dash on both corners", () => {
		const line = new SeparatorLine({ labelAlign: "right" });
		line.setRightLabel("review-session");
		const rendered = line.render(40)[0]!;
		expect(rendered.startsWith("─")).toBe(true);
		expect(rendered.endsWith("─")).toBe(true);
		expect(rendered).toContain(" review-session ");
		expect(visibleWidth(rendered)).toBe(40);
	});

	it("still keeps corner dashes when the title is wider than the row", () => {
		const line = new SeparatorLine({ labelAlign: "right" });
		line.setRightLabel("a-very-long-topic-title-that-would-eat-the-rule");
		const rendered = line.render(20)[0]!;
		expect(rendered.startsWith("─")).toBe(true);
		expect(rendered.endsWith("─")).toBe(true);
		expect(visibleWidth(rendered)).toBe(20);
	});
});
