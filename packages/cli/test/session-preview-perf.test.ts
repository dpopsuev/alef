/**
 * Performance gates for session-picker preview loading.
 *
 * Compares the pre-fix naive path (load on every focus) against
 * SessionPreviewLoader under rapid j/k navigation with slow I/O.
 *
 *   npx vitest run packages/cli/test/session-preview-perf.test.ts --tags-filter=benchmark
 */
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_PREVIEW_DEBOUNCE_MS, SessionPreviewLoader } from "../src/client/commands/session-preview-loader.js";

const SESSION_COUNT = 80;
const NAV_STEPS = 60;
/** Faster than debounce — holding j through the list. */
const KEY_INTERVAL_MS = 5;
/** Slow enough that naive navigation piles concurrent fetches. */
const PREVIEW_LATENCY_MS = 80;

function sessionIds(count: number): string[] {
	return ["__new__", ...Array.from({ length: count }, (_, i) => `s${i + 1}`)];
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pre-fix behavior: every focus change starts a preview fetch immediately. */
class NaivePreviewLoader {
	loadsStarted = 0;
	focusedUpdates = 0;
	focusChanges = 0;
	private focusedId: string | undefined;
	private readonly inFlight = new Set<string>();

	constructor(
		private readonly preview: {
			getSessionPreview(sessionId: string, maxTurns: number): Promise<unknown[]>;
		},
		private readonly onFocusedUpdate: () => void,
	) {}

	focus(sessionId: string): void {
		if (sessionId === this.focusedId || sessionId === "__new__") return;
		this.focusedId = sessionId;
		this.focusChanges++;
		if (this.inFlight.has(sessionId)) {
			this.focusedUpdates++;
			this.onFocusedUpdate();
			return;
		}
		this.loadsStarted++;
		this.inFlight.add(sessionId);
		this.focusedUpdates++;
		this.onFocusedUpdate();
		void this.preview.getSessionPreview(sessionId, 10).then(() => {
			this.inFlight.delete(sessionId);
			if (sessionId === this.focusedId) {
				this.focusedUpdates++;
				this.onFocusedUpdate();
			}
		});
	}
}

describe("session preview picker — performance", { tags: ["benchmark"] }, () => {
	beforeEach(() => {
		vi.useRealTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it(`debounced loader bounds fetches under ${NAV_STEPS}-step rapid nav (vs naive)`, async () => {
		const items = sessionIds(SESSION_COUNT);
		const path = items.filter((id) => id !== "__new__").slice(0, NAV_STEPS);

		let naivePeakInFlight = 0;
		let naiveInFlight = 0;
		const naivePreview = {
			getSessionPreview: async () => {
				naiveInFlight++;
				naivePeakInFlight = Math.max(naivePeakInFlight, naiveInFlight);
				await sleep(PREVIEW_LATENCY_MS);
				naiveInFlight--;
				return [];
			},
		};
		const naive = new NaivePreviewLoader(naivePreview, () => {});

		const t0 = performance.now();
		for (const id of path) {
			naive.focus(id);
			await sleep(KEY_INTERVAL_MS);
		}
		await sleep(PREVIEW_LATENCY_MS + 20);
		const naiveMs = performance.now() - t0;

		let debouncedPeakInFlight = 0;
		let debouncedInFlight = 0;
		const debouncedPreview = {
			getSessionPreview: async () => {
				debouncedInFlight++;
				debouncedPeakInFlight = Math.max(debouncedPeakInFlight, debouncedInFlight);
				await sleep(PREVIEW_LATENCY_MS);
				debouncedInFlight--;
				return [];
			},
		};
		const loader = new SessionPreviewLoader({
			preview: debouncedPreview,
			itemValues: () => items,
			onFocusedUpdate: () => {},
			debounceMs: SESSION_PREVIEW_DEBOUNCE_MS,
			neighborRadius: 1,
		});

		const t1 = performance.now();
		for (const id of path) {
			loader.focus(id);
			await sleep(KEY_INTERVAL_MS);
		}
		await sleep(SESSION_PREVIEW_DEBOUNCE_MS + PREVIEW_LATENCY_MS + 30);
		const debouncedMs = performance.now() - t1;
		const stats = loader.stats;
		loader.dispose();

		const settled = path[path.length - 1]!;
		const expectedMaxLoads = 3; // focused ± 1 neighbor

		console.log(
			[
				`nav=${NAV_STEPS} keyInterval=${KEY_INTERVAL_MS}ms latency=${PREVIEW_LATENCY_MS}ms`,
				`naive:   loads=${naive.loadsStarted} updates=${naive.focusedUpdates} peakInFlight=${naivePeakInFlight} wall=${naiveMs.toFixed(0)}ms`,
				`debounce: loads=${stats.loadsStarted} updates=${stats.focusedUpdates} peakInFlight=${debouncedPeakInFlight} wall=${debouncedMs.toFixed(0)}ms focusChanges=${stats.focusChanges}`,
				`settled=${settled}`,
			].join("\n"),
		);

		// Correctness: only settled window is fetched.
		expect(stats.loadsStarted).toBeLessThanOrEqual(expectedMaxLoads);
		expect(stats.loadsStarted).toBeGreaterThanOrEqual(1);
		expect(stats.focusChanges).toBe(NAV_STEPS);

		// Performance gates vs naive path.
		expect(stats.loadsStarted).toBeLessThan(naive.loadsStarted / 5);
		expect(stats.focusedUpdates).toBeLessThan(naive.focusedUpdates / 3);
		expect(debouncedPeakInFlight).toBeLessThanOrEqual(expectedMaxLoads);
		expect(naivePeakInFlight).toBeGreaterThan(10);

		// Peak concurrency is the hang signal — naive piles I/O; debounce caps it.
		expect(debouncedPeakInFlight).toBeLessThan(naivePeakInFlight / 3);
	}, 30_000);

	it("fake-timer stress: 200 focus hops → ≤3 loads after settle", async () => {
		vi.useFakeTimers();
		const hops = 200;
		const items = sessionIds(hops + 5);
		const path = items.filter((id) => id !== "__new__").slice(0, hops);

		const loader = new SessionPreviewLoader({
			preview: {
				getSessionPreview: async () => [],
			},
			itemValues: () => items,
			onFocusedUpdate: () => {},
			debounceMs: SESSION_PREVIEW_DEBOUNCE_MS,
			neighborRadius: 1,
		});

		const t0 = performance.now();
		for (const id of path) loader.focus(id);
		expect(loader.stats.loadsStarted).toBe(0);

		await vi.advanceTimersByTimeAsync(SESSION_PREVIEW_DEBOUNCE_MS);
		await Promise.resolve();
		const cpuMs = performance.now() - t0;

		console.log(
			`200 hops: loads=${loader.stats.loadsStarted} updates=${loader.stats.focusedUpdates} cpu=${cpuMs.toFixed(2)}ms`,
		);

		expect(loader.stats.loadsStarted).toBeLessThanOrEqual(3);
		expect(loader.stats.focusChanges).toBe(hops);
		// Pure scheduling work for 200 hops must stay cheap (no I/O yet until settle).
		expect(cpuMs).toBeLessThan(50);

		loader.dispose();
		vi.useRealTimers();
	});
});
