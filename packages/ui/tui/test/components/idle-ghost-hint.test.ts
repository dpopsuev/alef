import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdleGhostHint } from "../../src/components/idle-ghost-hint.js";

describe("IdleGhostHint", { tags: ["unit"] }, () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("typewrites the default colon hint after 10s of empty idle", () => {
		let empty = true;
		const requestRender = vi.fn();
		const ghost = new IdleGhostHint({
			isEmpty: () => empty,
			requestRender,
			style: (s) => s,
		});
		ghost.arm();
		expect(ghost.overlay()).toBe("");

		vi.advanceTimersByTime(9_999);
		expect(ghost.revealedText).toBe("");

		vi.advanceTimersByTime(1);
		expect(requestRender).toHaveBeenCalled();
		vi.advanceTimersByTime(28 * 20);
		expect(ghost.revealedText).toBe(": for commands");
		expect(ghost.overlay()).toBe(": for commands");
		ghost.dispose();
	});

	it("clears on activity and does not show while non-empty", () => {
		let empty = true;
		const ghost = new IdleGhostHint({
			isEmpty: () => empty,
			requestRender: () => {},
			style: (s) => s,
		});
		ghost.arm();
		vi.advanceTimersByTime(10_000);
		vi.advanceTimersByTime(28 * 5);
		expect(ghost.revealedText.length).toBeGreaterThan(0);

		empty = false;
		ghost.onActivity();
		expect(ghost.revealedText).toBe("");
		expect(ghost.overlay()).toBe("");

		empty = true;
		ghost.onActivity();
		vi.advanceTimersByTime(10_000);
		vi.advanceTimersByTime(28);
		expect(ghost.revealedText.length).toBeGreaterThan(0);
		ghost.dispose();
	});

	it("show() typewrites immediately when empty", () => {
		const ghost = new IdleGhostHint({
			isEmpty: () => true,
			requestRender: () => {},
			style: (s) => `dim:${s}`,
		});
		ghost.show("Tab to inspect subagents");
		vi.advanceTimersByTime(28 * 30);
		expect(ghost.revealedText).toBe("Tab to inspect subagents");
		expect(ghost.overlay()).toBe("dim:Tab to inspect subagents");
		ghost.dispose();
	});

	it("dismisses after dwell and re-arms idle", () => {
		const ghost = new IdleGhostHint({
			isEmpty: () => true,
			requestRender: () => {},
			style: (s) => s,
			dismissMs: 1_000,
		});
		ghost.arm();
		vi.advanceTimersByTime(10_000);
		vi.advanceTimersByTime(28 * 20);
		expect(ghost.revealedText).toBe(": for commands");
		vi.advanceTimersByTime(1_000);
		expect(ghost.revealedText).toBe("");
		vi.advanceTimersByTime(10_000);
		vi.advanceTimersByTime(28);
		expect(ghost.revealedText.length).toBeGreaterThan(0);
		ghost.dispose();
	});
});
