import { describe, expect, it } from "vitest";
import { PendingQueuePanel } from "../src/components/pending-queue.js";
import { visibleWidth } from "../src/utils.js";

const theme = {
	item: (s: string) => s,
	hint: (s: string) => s,
};

describe("PendingQueuePanel", { tags: ["unit"] }, () => {
	it("renders nothing when empty", () => {
		const panel = new PendingQueuePanel({ theme });
		expect(panel.render(40)).toEqual([]);
		expect(panel.size).toBe(0);
	});

	it("renders truncated item lines with optional hint", () => {
		const panel = new PendingQueuePanel({
			theme,
			hint: "Esc to edit queued messages",
		});
		panel.push({ text: "first", prefix: "Follow-up" });
		panel.push({ text: "second" });

		const lines = panel.render(40);
		expect(lines[0]).toBe("");
		expect(lines[1]).toContain("Follow-up: first");
		expect(lines[2]).toContain("second");
		expect(lines[3]).toContain("Esc to edit queued messages");
		for (const line of lines.slice(1)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		}
	});

	it("setLength drops drained FIFO head entries", () => {
		const panel = new PendingQueuePanel({ theme });
		panel.push({ text: "a" });
		panel.push({ text: "b" });
		panel.push({ text: "c" });
		panel.setLength(1);
		expect(panel.getItems().map((e) => e.text)).toEqual(["c"]);
		panel.setLength(0);
		expect(panel.size).toBe(0);
		expect(panel.render(20)).toEqual([]);
	});

	it("maxVisible summarizes overflow", () => {
		const panel = new PendingQueuePanel({ theme, maxVisible: 2 });
		panel.push({ text: "a" });
		panel.push({ text: "b" });
		panel.push({ text: "c" });
		const lines = panel.render(40);
		expect(lines.some((l) => l.includes("a"))).toBe(true);
		expect(lines.some((l) => l.includes("b"))).toBe(true);
		expect(lines.some((l) => l.includes("+1 more"))).toBe(true);
		expect(lines.some((l) => l.includes("c"))).toBe(false);
	});
});
