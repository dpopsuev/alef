/**
 * Rapid session-picker navigation must not fire a preview load per keystroke.
 * Loads start only after focus settles (debounce), then include neighbors.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	neighborSessionIds,
	SESSION_PREVIEW_DEBOUNCE_MS,
	SessionPreviewLoader,
} from "../src/client/commands/session-preview-loader.js";

describe("neighborSessionIds", { tags: ["unit"] }, () => {
	it("skips __new__ and returns focused ± radius", () => {
		const values = ["__new__", "a", "b", "c", "d"];
		expect(neighborSessionIds(values, "c", 1)).toEqual(["b", "c", "d"]);
		expect(neighborSessionIds(values, "a", 1)).toEqual(["a", "b"]);
		expect(neighborSessionIds(values, "__new__", 1)).toEqual([]);
	});
});

describe("SessionPreviewLoader debounce", { tags: ["unit"] }, () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("rapid focus changes do not start loads until focus settles", async () => {
		const calls: string[] = [];
		const slow = new Map<string, () => void>();
		const preview = {
			getSessionPreview: (sessionId: string) =>
				new Promise<[]>((resolve) => {
					calls.push(sessionId);
					slow.set(sessionId, () => resolve([]));
				}),
		};

		const items = ["__new__", "s1", "s2", "s3", "s4", "s5"];
		const updates: string[] = [];
		const loader = new SessionPreviewLoader({
			preview,
			itemValues: () => items,
			onFocusedUpdate: () => updates.push(loader.focused ?? ""),
			debounceMs: SESSION_PREVIEW_DEBOUNCE_MS,
			neighborRadius: 1,
		});

		// Simulate holding j through the list — previewFn/focus every step.
		loader.focus("s1");
		loader.focus("s2");
		loader.focus("s3");
		loader.focus("s4");
		expect(calls).toEqual([]);
		expect(loader.isPending("s4")).toBe(true);
		expect(loader.cache.size).toBe(0);

		await vi.advanceTimersByTimeAsync(SESSION_PREVIEW_DEBOUNCE_MS - 1);
		expect(calls).toEqual([]);

		await vi.advanceTimersByTimeAsync(1);
		// Settled on s4 → load s3, s4, s5 in parallel (not s1/s2).
		expect(calls.sort()).toEqual(["s3", "s4", "s5"]);
		expect(calls).not.toContain("s1");
		expect(calls).not.toContain("s2");

		for (const resolve of slow.values()) resolve();
		await Promise.resolve();
		expect(loader.cache.get("s4")?.loading).toBe(false);
		loader.dispose();
	});

	it("does not reset debounce when focus is painted repeatedly for the same session", async () => {
		const calls: string[] = [];
		const preview = {
			getSessionPreview: async (sessionId: string) => {
				calls.push(sessionId);
				return [];
			},
		};
		const loader = new SessionPreviewLoader({
			preview,
			itemValues: () => ["__new__", "only"],
			onFocusedUpdate: () => {},
			debounceMs: SESSION_PREVIEW_DEBOUNCE_MS,
		});

		loader.focus("only");
		await vi.advanceTimersByTimeAsync(SESSION_PREVIEW_DEBOUNCE_MS / 2);
		loader.focus("only");
		loader.focus("only");
		await vi.advanceTimersByTimeAsync(SESSION_PREVIEW_DEBOUNCE_MS / 2);
		expect(calls).toEqual(["only"]);
		loader.dispose();
	});

	it("stale in-flight preview for a skipped session does not thrash focused renders", async () => {
		type Resolver = (blocks: []) => void;
		const resolvers = new Map<string, Resolver>();
		const preview = {
			getSessionPreview: (sessionId: string) =>
				new Promise<[]>((resolve) => {
					resolvers.set(sessionId, resolve);
				}),
		};
		const focusedUpdates: string[] = [];
		const loader = new SessionPreviewLoader({
			preview,
			itemValues: () => ["a", "b", "c"],
			onFocusedUpdate: () => focusedUpdates.push(loader.focused ?? ""),
			debounceMs: 50,
			neighborRadius: 0,
		});

		loader.focus("a");
		await vi.advanceTimersByTimeAsync(50);
		expect(resolvers.has("a")).toBe(true);

		loader.focus("c");
		await vi.advanceTimersByTimeAsync(50);
		expect(resolvers.has("c")).toBe(true);

		focusedUpdates.length = 0;
		resolvers.get("a")!([]);
		await Promise.resolve();
		// a completed while focused is c — cache may update, but no focused render.
		expect(focusedUpdates).toEqual([]);

		resolvers.get("c")!([]);
		await Promise.resolve();
		expect(focusedUpdates).toEqual(["c"]);
		loader.dispose();
	});

	it("loadNow bypasses debounce for scroll-more", async () => {
		const calls: Array<{ id: string; turns: number }> = [];
		const preview = {
			getSessionPreview: async (sessionId: string, maxTurns: number) => {
				calls.push({ id: sessionId, turns: maxTurns });
				return [{ kind: "user" as const, text: "hi" }];
			},
		};
		const loader = new SessionPreviewLoader({
			preview,
			itemValues: () => ["s1"],
			onFocusedUpdate: () => {},
			debounceMs: 500,
		});
		loader.focus("s1");
		loader.loadNow("s1", 18);
		expect(calls).toEqual([{ id: "s1", turns: 18 }]);
		await Promise.resolve();
		loader.dispose();
	});
});
