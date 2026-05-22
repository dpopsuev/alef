/**
 * Typewriter tests.
 *
 * Core contract:
 *   - One tick per frame (default 16ms, ~60fps)
 *   - markStreamDone() is metadata only — does NOT change drain speed
 *   - Hard cap on chars per tick — never a blob dump
 *   - flush() is for internal resets only (abort, clear)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Typewriter, type TypewriterConfig, type TypewriterSink } from "../src/typewriter.js";

function makeSink(): TypewriterSink & { value: string } {
	const sink = {
		value: "",
		setText(t: string) {
			sink.value = t;
		},
	};
	return sink;
}

function makeWriter(sink: TypewriterSink, cfg?: TypewriterConfig) {
	const renders: number[] = [];
	const tw = new Typewriter(sink, () => renders.push(Date.now()), cfg);
	return { tw, renders };
}

// ---------------------------------------------------------------------------
// charsPerTick — frame budget, hard cap
// ---------------------------------------------------------------------------

describe("charsPerTick — frame-budget character reveal", () => {
	it("reveals 1 char when pressure is low (≤20) — letter-by-letter trickle", () => {
		const { tw } = makeWriter(makeSink());
		expect(tw.charsPerTick(1)).toBe(1);
		expect(tw.charsPerTick(20)).toBe(1);
	});

	it("reveals 2 chars at moderate pressure (20–80)", () => {
		const { tw } = makeWriter(makeSink());
		expect(tw.charsPerTick(21)).toBe(2);
		expect(tw.charsPerTick(80)).toBe(2);
	});

	it("reveals 4 chars at high pressure (80–250)", () => {
		const { tw } = makeWriter(makeSink());
		expect(tw.charsPerTick(81)).toBe(4);
		expect(tw.charsPerTick(250)).toBe(4);
	});

	it("caps at maxCharsPerTick (8) — drain mode, never a dump", () => {
		const { tw } = makeWriter(makeSink());
		expect(tw.charsPerTick(251)).toBe(8);
		expect(tw.charsPerTick(10_000)).toBe(8);
	});

	it("respects custom maxCharsPerTick config", () => {
		const { tw } = makeWriter(makeSink(), { maxCharsPerTick: 16 });
		expect(tw.charsPerTick(1000)).toBe(16);
	});
});

// ---------------------------------------------------------------------------
// markStreamDone does NOT change drain speed
// ---------------------------------------------------------------------------

describe("markStreamDone — metadata only, no rate change", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("markStreamDone does not flush content immediately", () => {
		const sink = makeSink();
		const { tw } = makeWriter(sink, { tickMs: 16 });
		tw.receive("a".repeat(200));
		tw.markStreamDone();
		// No time has passed — nothing revealed yet
		expect(sink.value.length).toBe(0);
	});

	it("drain rate after markStreamDone is capped — not a dump", () => {
		const sink = makeSink();
		const { tw } = makeWriter(sink, { tickMs: 16, maxCharsPerTick: 8 });
		tw.receive("a".repeat(500));
		tw.markStreamDone();

		// After one tick (16ms): at most 8 chars revealed (drain mode cap)
		vi.advanceTimersByTime(16);
		expect(sink.value.length).toBeLessThanOrEqual(8);
	});

	it("buffer drains fully at paced rate after markStreamDone", () => {
		const sink = makeSink();
		const { tw } = makeWriter(sink, { tickMs: 16, maxCharsPerTick: 8 });
		tw.receive("hello world");
		tw.markStreamDone();
		vi.advanceTimersByTime(500);
		expect(sink.value).toBe("hello world");
	});
});

// ---------------------------------------------------------------------------
// Smooth trickle while streaming
// ---------------------------------------------------------------------------

describe("Streaming — smooth reveal per frame", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("does not reveal all content in the first tick", () => {
		const sink = makeSink();
		const { tw } = makeWriter(sink, { tickMs: 16 });
		tw.receive("a".repeat(200));

		vi.advanceTimersByTime(16);
		expect(sink.value.length).toBeGreaterThan(0);
		expect(sink.value.length).toBeLessThanOrEqual(8); // hard cap = 8
	});

	it("triggers a render on every tick with visible output", () => {
		const sink = makeSink();
		const { tw, renders } = makeWriter(sink, { tickMs: 16 });
		tw.receive("abcde");
		vi.advanceTimersByTime(200);
		expect(renders.length).toBeGreaterThan(0);
	});

	it("stops ticking once fully caught up — no wasted renders", () => {
		const sink = makeSink();
		const { tw, renders } = makeWriter(sink, { tickMs: 16 });
		tw.receive("hi");
		vi.advanceTimersByTime(500);
		const settled = renders.length;
		vi.advanceTimersByTime(500);
		expect(renders.length).toBe(settled);
	});

	it("reveals all content eventually", () => {
		const sink = makeSink();
		const { tw } = makeWriter(sink, { tickMs: 16 });
		tw.receive("hello world");
		vi.advanceTimersByTime(1000);
		expect(sink.value).toBe("hello world");
	});

	it("resumes when new content arrives after catching up", () => {
		const sink = makeSink();
		const { tw } = makeWriter(sink, { tickMs: 16 });
		tw.receive("hi");
		vi.advanceTimersByTime(500);
		tw.receive(" world");
		vi.advanceTimersByTime(500);
		expect(sink.value).toBe("hi world");
	});
});

// ---------------------------------------------------------------------------
// whenDrained
// ---------------------------------------------------------------------------

describe("whenDrained — completion signal", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("resolves immediately when nothing is pending", async () => {
		const { tw } = makeWriter(makeSink());
		await expect(tw.whenDrained()).resolves.toBeUndefined();
	});

	it("resolves only after all pending content is revealed", async () => {
		const sink = makeSink();
		const { tw } = makeWriter(sink, { tickMs: 16 });
		tw.receive("hello");
		tw.markStreamDone();

		const drained = tw.whenDrained();
		vi.advanceTimersByTime(1000);
		await expect(drained).resolves.toBeUndefined();
		expect(sink.value).toBe("hello");
	});

	it("multiple callers all receive the completion signal", async () => {
		const { tw } = makeWriter(makeSink(), { tickMs: 16 });
		tw.receive("abc");
		tw.markStreamDone();

		const [a, b] = [tw.whenDrained(), tw.whenDrained()];
		vi.advanceTimersByTime(1000);
		await expect(Promise.all([a, b])).resolves.toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// flush / reset — internal use only
// ---------------------------------------------------------------------------

describe("flush and reset — internal lifecycle", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("flush reveals all pending content immediately (for abort/reset)", () => {
		const sink = makeSink();
		const { tw } = makeWriter(sink);
		tw.receive("hello world");
		tw.flush();
		expect(sink.value).toBe("hello world");
	});

	it("flush cancels any scheduled tick", () => {
		const sink = makeSink();
		const { tw, renders } = makeWriter(sink, { tickMs: 16 });
		tw.receive("hi");
		tw.flush();
		const after = renders.length;
		vi.advanceTimersByTime(500);
		expect(renders.length).toBe(after);
	});

	it("reset clears all state", () => {
		const sink = makeSink();
		const { tw } = makeWriter(sink, { tickMs: 16 });
		tw.receive("hello");
		tw.reset();
		expect(tw.pressure).toBe(0);
		vi.advanceTimersByTime(500);
		expect(sink.value).toBe("hello"); // flush happened, but no more ticks
	});
});

// ---------------------------------------------------------------------------
// Custom sink
// ---------------------------------------------------------------------------

describe("custom sink", () => {
	it("works with any TypewriterSink", () => {
		const received: string[] = [];
		const tw = new Typewriter({ setText: (t) => received.push(t) }, () => {});
		tw.receive("abc");
		tw.flush();
		expect(received.at(-1)).toBe("abc");
	});
});
