/**
 * Top→bottom session-picker scroll against a real synthetic SQLite corpus.
 *
 * Exercises: list → SelectItems → SessionPreviewLoader → PreviewSelectList →
 * renderDisplayBlocksToLines. Calibration injects sync cost; p95 must rise.
 */

import { createSyntheticCorpus } from "@dpopsuev/alef-storage/testing/synthetic-sessions";
import { afterEach, describe, expect, it } from "vitest";
import { createSyntheticPickerHarness } from "./helpers/synthetic-picker-harness.js";

const SESSION_COUNT = 48;
const INJECTED_SYNC_MS = 3;
const WIDTH = 120;

describe("session picker scroll — synthetic corpus", { tags: ["benchmark"] }, () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const fn of cleanups.splice(0)) fn();
	});

	async function buildCorpus() {
		const corpus = await createSyntheticCorpus({
			cwd: "/tmp/alef-picker-bench",
			altCwd: "/tmp/alef-picker-bench-alt",
			sessions: SESSION_COUNT,
			profileMix: ["tiny", "medium", "heavy", "noisy", "medium", "heavy"],
		});
		cleanups.push(corpus.cleanup);
		return corpus;
	}

	it("corpus materializes enough heavy sessions for a meaningful scroll", async () => {
		const corpus = await buildCorpus();
		expect(corpus.stats.sessionCount).toBe(SESSION_COUNT);
		expect(corpus.stats.totalEvents).toBeGreaterThan(SESSION_COUNT * 20);
		expect(corpus.stats.byProfile.heavy).toBeGreaterThan(5);

		const listed = await corpus.list();
		expect(listed.length).toBeGreaterThan(30);
		expect(listed.every((entry) => entry.searchBlob && entry.name)).toBe(true);

		const sample = corpus.sessions.find((session) => session.profile === "heavy")!;
		const preview = await corpus.preview.getSessionPreview(sample.id, 10);
		expect(preview.length).toBeGreaterThan(10);
	}, 60_000);

	it("calibration: injected block-render cost raises warm-scroll p95", async () => {
		const corpus = await buildCorpus();

		const cheapHarness = await createSyntheticPickerHarness({
			corpus,
			memoize: true,
			injectSyncMs: 0,
			debounceMs: 0,
		});
		cleanups.push(() => cheapHarness.dispose());
		await cheapHarness.warmAllPreviews(10);
		const cheap = await cheapHarness.scrollTopToBottom({ width: WIDTH });

		const expensiveHarness = await createSyntheticPickerHarness({
			corpus,
			memoize: false,
			injectSyncMs: INJECTED_SYNC_MS,
			debounceMs: 0,
			doubleRefresh: false,
		});
		cleanups.push(() => expensiveHarness.dispose());
		await expensiveHarness.warmAllPreviews(10);
		const expensive = await expensiveHarness.scrollTopToBottom({ width: WIDTH });

		console.log(
			[
				`corpus: sessions=${corpus.stats.sessionCount} events=${corpus.stats.totalEvents} heavy=${corpus.stats.byProfile.heavy}`,
				`cheap:     p50=${cheap.p50Ms.toFixed(2)}ms p95=${cheap.p95Ms.toFixed(2)}ms renders=${cheap.blockRenderCalls} previewFn=${cheap.previewFnCalls}`,
				`expensive: p50=${expensive.p50Ms.toFixed(2)}ms p95=${expensive.p95Ms.toFixed(2)}ms renders=${expensive.blockRenderCalls} previewFn=${expensive.previewFnCalls}`,
			].join("\n"),
		);

		expect(cheap.steps).toBeGreaterThan(20);
		expect(expensive.p95Ms).toBeGreaterThan(cheap.p95Ms + INJECTED_SYNC_MS * 0.5);
		expect(expensive.meanMs).toBeGreaterThan(cheap.meanMs + INJECTED_SYNC_MS * 0.5);
	}, 120_000);

	it("memo + dirty-flag beats legacy double-refresh without memo (warm)", async () => {
		const corpus = await buildCorpus();

		const fixed = await createSyntheticPickerHarness({
			corpus,
			memoize: true,
			injectSyncMs: 0,
			debounceMs: 0,
		});
		cleanups.push(() => fixed.dispose());
		await fixed.warmAllPreviews(10);
		const fixedStats = await fixed.scrollTopToBottom({ width: WIDTH });

		const legacy = await createSyntheticPickerHarness({
			corpus,
			memoize: false,
			injectSyncMs: 0,
			debounceMs: 0,
			doubleRefresh: true,
		});
		cleanups.push(() => legacy.dispose());
		await legacy.warmAllPreviews(10);
		const legacyStats = await legacy.scrollTopToBottom({ width: WIDTH });

		console.log(
			[
				`fixed:  p95=${fixedStats.p95Ms.toFixed(2)}ms mean=${fixedStats.meanMs.toFixed(2)}ms total=${fixedStats.totalMs.toFixed(0)}ms renders=${fixedStats.blockRenderCalls} previewFn=${fixedStats.previewFnCalls}`,
				`legacy: p95=${legacyStats.p95Ms.toFixed(2)}ms mean=${legacyStats.meanMs.toFixed(2)}ms total=${legacyStats.totalMs.toFixed(0)}ms renders=${legacyStats.blockRenderCalls} previewFn=${legacyStats.previewFnCalls}`,
			].join("\n"),
		);

		// Structural: legacy rebuilds preview twice per key; fixed once.
		expect(legacyStats.previewFnCalls).toBeGreaterThanOrEqual(fixedStats.previewFnCalls * 1.8);
		expect(legacyStats.blockRenderCalls).toBeGreaterThanOrEqual(fixedStats.blockRenderCalls * 1.8);
		// Wall: total scroll work must be higher when paying ChatLog twice.
		expect(fixedStats.totalMs).toBeLessThan(legacyStats.totalMs);
		expect(fixedStats.meanMs).toBeLessThan(legacyStats.meanMs);
	}, 120_000);

	it("cold rapid scroll does not start a load per key (debounce)", async () => {
		const corpus = await buildCorpus();
		const harness = await createSyntheticPickerHarness({
			corpus,
			memoize: true,
			debounceMs: 120,
		});
		cleanups.push(() => harness.dispose());

		const stats = await harness.scrollTopToBottom({ width: WIDTH });
		console.log(
			`cold scroll: p95=${stats.p95Ms.toFixed(2)}ms loads=${stats.loadsStarted} previewFn=${stats.previewFnCalls}`,
		);

		// Rapid j never settles long enough for neighbor window — at most a handful.
		expect(stats.loadsStarted).toBeLessThan(10);
		expect(stats.previewFnCalls).toBeGreaterThan(20);
	}, 120_000);
});
