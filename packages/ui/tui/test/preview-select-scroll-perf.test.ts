/**
 * Top→bottom session-picker scroll paint path.
 *
 * Measures handleInput("j") + render() — the real lag surface.
 * Calibration: injecting sync cost into previewFn must raise p95;
 * if it does not, the harness is not measuring the scroll path.
 */
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { PreviewSelectList } from "../src/components/preview-select-list.js";
import type { SelectItem } from "../src/components/select-list.js";

const theme = {
	selectedPrefix: (s: string) => s,
	selectedText: (s: string) => s,
	description: (s: string) => s,
	scrollInfo: (s: string) => s,
	noMatch: (s: string) => s,
};

const SESSION_COUNT = 80;
const WIDTH = 120;
/** Artificial sync cost — must move p95 if harness is valid. */
const INJECTED_SYNC_MS = 3;

function makeItems(count: number): SelectItem[] {
	return Array.from({ length: count }, (_, i) => ({
		value: `s${i + 1}`,
		label: `Session ${i + 1}`,
		description: `2026-07-18 12:${String(i % 60).padStart(2, "0")}`,
	}));
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
	return sorted[Math.max(0, index)]!;
}

function busyWait(ms: number): void {
	const end = performance.now() + ms;
	while (performance.now() < end) {
		/* spin */
	}
}

function fatPreviewLines(sessionId: string): string[] {
	return Array.from({ length: 40 }, (_, line) => `${sessionId} preview line ${line} ${"x".repeat(48)}`);
}

interface ScrollStats {
	steps: number;
	previewCalls: number;
	p50Ms: number;
	p95Ms: number;
	meanMs: number;
	totalMs: number;
}

function scrollTopToBottom(
	previewFn: (item: SelectItem | undefined, width: number) => string[],
): ScrollStats {
	const items = makeItems(SESSION_COUNT);
	let previewCalls = 0;
	const list = new PreviewSelectList({
		items,
		maxVisible: 12,
		theme,
		pinPreviewToEnd: true,
		previewFn: (item, width) => {
			previewCalls++;
			return previewFn(item, width);
		},
	});

	list.render(WIDTH);

	const stepMs: number[] = [];
	for (let step = 1; step < SESSION_COUNT; step++) {
		const t0 = performance.now();
		list.handleInput("j");
		list.render(WIDTH);
		stepMs.push(performance.now() - t0);
	}

	const sorted = [...stepMs].sort((a, b) => a - b);
	const totalMs = stepMs.reduce((sum, value) => sum + value, 0);
	return {
		steps: stepMs.length,
		previewCalls,
		p50Ms: percentile(sorted, 50),
		p95Ms: percentile(sorted, 95),
		meanMs: totalMs / stepMs.length,
		totalMs,
	};
}

describe("PreviewSelectList scroll — paint path", { tags: ["benchmark"] }, () => {
	it("calibration: injected sync cost in previewFn raises scroll p95", () => {
		const cheapCache = new Map<string, string[]>();
		const cheap = scrollTopToBottom((item) => {
			const id = item?.value ?? "";
			let lines = cheapCache.get(id);
			if (!lines) {
				lines = fatPreviewLines(id);
				cheapCache.set(id, lines);
			}
			return lines;
		});

		const expensive = scrollTopToBottom((item) => {
			busyWait(INJECTED_SYNC_MS);
			return fatPreviewLines(item?.value ?? "");
		});

		console.log(
			[
				`cheap:     p50=${cheap.p50Ms.toFixed(2)}ms p95=${cheap.p95Ms.toFixed(2)}ms mean=${cheap.meanMs.toFixed(2)}ms calls=${cheap.previewCalls}`,
				`expensive: p50=${expensive.p50Ms.toFixed(2)}ms p95=${expensive.p95Ms.toFixed(2)}ms mean=${expensive.meanMs.toFixed(2)}ms calls=${expensive.previewCalls}`,
			].join("\n"),
		);

		// Harness validity: measuring the paint path must see the injected cost.
		expect(expensive.p95Ms).toBeGreaterThan(cheap.p95Ms + INJECTED_SYNC_MS * 0.6);
		expect(expensive.meanMs).toBeGreaterThan(cheap.meanMs + INJECTED_SYNC_MS * 0.6);
		expect(expensive.previewCalls).toBe(SESSION_COUNT);
		// Dirty-flag path: one preview build per selection (initial + each j).
		expect(cheap.previewCalls).toBe(SESSION_COUNT);
	});

	it("pre-fix double refresh is slower than dirty-flag single rebuild", () => {
		const dirtyFlag = scrollTopToBottom((item) => {
			busyWait(1);
			return fatPreviewLines(item?.value ?? "");
		});

		const items = makeItems(SESSION_COUNT);
		let calls = 0;
		const list = new PreviewSelectList({
			items,
			maxVisible: 12,
			theme,
			previewFn: (item) => {
				calls++;
				busyWait(1);
				return fatPreviewLines(item?.value ?? "");
			},
		});
		list.render(WIDTH);
		const doubleBuildMs: number[] = [];
		for (let step = 1; step < SESSION_COUNT; step++) {
			const t0 = performance.now();
			list.handleInput("j");
			list.render(WIDTH); // selection dirty → build #1
			list.invalidatePreview();
			list.render(WIDTH); // forced rebuild → build #2 (pre-fix double-refresh)
			doubleBuildMs.push(performance.now() - t0);
		}
		const doubleSorted = [...doubleBuildMs].sort((a, b) => a - b);
		const doubleP95 = percentile(doubleSorted, 95);

		console.log(
			[
				`dirty-flag:   p95=${dirtyFlag.p95Ms.toFixed(2)}ms calls=${dirtyFlag.previewCalls}`,
				`double-build: p95=${doubleP95.toFixed(2)}ms calls=${calls}`,
			].join("\n"),
		);

		expect(calls).toBeGreaterThan(dirtyFlag.previewCalls);
		expect(doubleP95).toBeGreaterThan(dirtyFlag.p95Ms * 1.3);
	});

	it("warm fat-preview scroll p95 stays interactive", () => {
		const cache = new Map<string, string[]>();
		const stats = scrollTopToBottom((item) => {
			const id = item?.value ?? "";
			let lines = cache.get(id);
			if (!lines) {
				lines = fatPreviewLines(id);
				cache.set(id, lines);
			}
			return lines;
		});

		console.log(
			`warm scroll: p50=${stats.p50Ms.toFixed(2)}ms p95=${stats.p95Ms.toFixed(2)}ms mean=${stats.meanMs.toFixed(2)}ms`,
		);

		// Interactive budget for a key→frame on a warm preview (CI headroom).
		expect(stats.p95Ms).toBeLessThan(8);
		expect(stats.meanMs).toBeLessThan(4);
	});
});
