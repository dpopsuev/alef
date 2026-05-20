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

function makeTypewriter(sink: TypewriterSink, cfg?: TypewriterConfig) {
	const renders: number[] = [];
	const tw = new Typewriter(sink, () => renders.push(Date.now()), cfg);
	return { tw, renders };
}

describe("Typewriter — pressure and step size", () => {
	it("pressureStep returns 1 for gap ≤ 2 while streaming", () => {
		const { tw } = makeTypewriter(makeSink());
		tw.receive("ab"); // gap = 2, streaming = true, lastChunkAt = now
		expect(tw.pressureStep(2)).toBe(1);
		expect(tw.pressureStep(1)).toBe(1);
	});

	it("pressureStep escalates with gap while streaming, capped at 12", () => {
		const { tw } = makeTypewriter(makeSink());
		tw.receive("x"); // mark streaming active
		expect(tw.pressureStep(8)).toBe(2);
		expect(tw.pressureStep(25)).toBe(4);
		expect(tw.pressureStep(70)).toBe(8);
		expect(tw.pressureStep(180)).toBe(12); // capped
		expect(tw.pressureStep(400)).toBe(12); // still capped
	});

	it("pressureStep drains half the gap when stream is done", () => {
		const { tw } = makeTypewriter(makeSink());
		tw.markStreamDone();
		expect(tw.pressureStep(100)).toBe(50);
		expect(tw.pressureStep(7)).toBe(4); // ceil(7/2)
		expect(tw.pressureStep(1)).toBe(1); // floor of 0.5 → ceil = 1
	});

	it("pressure is 0 before any content", () => {
		const { tw } = makeTypewriter(makeSink());
		expect(tw.pressure).toBe(0);
	});

	it("pressure equals gap between pending and displayed", () => {
		const { tw } = makeTypewriter(makeSink());
		tw.receive("hello world");
		expect(tw.pressure).toBe(11);
	});
});

describe("Typewriter — effectivelyDone", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("is true before any chunk", () => {
		const { tw } = makeTypewriter(makeSink());
		expect(tw.effectivelyDone).toBe(true);
	});

	it("is false immediately after a chunk while streaming", () => {
		const { tw } = makeTypewriter(makeSink());
		tw.receive("hi");
		expect(tw.effectivelyDone).toBe(false);
	});

	it("is true after streaming pause threshold elapses", () => {
		const { tw } = makeTypewriter(makeSink(), { streamingPauseMs: 150 });
		tw.receive("hi");
		vi.advanceTimersByTime(151);
		expect(tw.effectivelyDone).toBe(true);
	});

	it("is true immediately after markStreamDone", () => {
		const { tw } = makeTypewriter(makeSink());
		tw.receive("hi");
		tw.markStreamDone();
		expect(tw.effectivelyDone).toBe(true);
	});
});

describe("Typewriter — nextTickMs", () => {
	it("returns slowMs for pressure ≤ 3 while streaming", () => {
		const { tw } = makeTypewriter(makeSink(), { intervals: { slowMs: 32, normalMs: 16, fastMs: 8 } });
		tw.receive("ab"); // gap = 2
		expect(tw.nextTickMs()).toBe(32);
	});

	it("returns normalMs for medium pressure while streaming", () => {
		const { tw } = makeTypewriter(makeSink(), { intervals: { slowMs: 32, normalMs: 16, fastMs: 8 } });
		tw.receive("a".repeat(20)); // gap = 20
		expect(tw.nextTickMs()).toBe(16);
	});

	it("returns fastMs for high pressure while streaming", () => {
		const { tw } = makeTypewriter(makeSink(), { intervals: { slowMs: 32, normalMs: 16, fastMs: 8 } });
		tw.receive("a".repeat(100)); // gap = 100 > 60
		expect(tw.nextTickMs()).toBe(8);
	});

	it("returns fastMs when stream is done regardless of pressure", () => {
		const { tw } = makeTypewriter(makeSink(), { intervals: { slowMs: 32, normalMs: 16, fastMs: 8 } });
		tw.receive("ab");
		tw.markStreamDone();
		expect(tw.nextTickMs()).toBe(8);
	});
});

describe("Typewriter — tick behaviour (fake timers)", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("reveals content incrementally, not all at once", () => {
		const sink = makeSink();
		const { tw } = makeTypewriter(sink, { intervals: { slowMs: 32, normalMs: 16, fastMs: 8 } });
		tw.receive("hello");

		vi.advanceTimersByTime(32); // one slow tick — gap=5, step=2
		expect(sink.value.length).toBeGreaterThan(0);
		expect(sink.value.length).toBeLessThan(5); // not all at once
	});

	it("eventually reveals all content after enough ticks", () => {
		const sink = makeSink();
		const { tw } = makeTypewriter(sink);
		tw.receive("hello world");

		vi.advanceTimersByTime(500); // many ticks
		expect(sink.value).toBe("hello world");
	});

	it("renders on every tick that produces output", () => {
		const sink = makeSink();
		const { tw, renders } = makeTypewriter(sink);
		tw.receive("abcde");

		vi.advanceTimersByTime(200);
		expect(renders.length).toBeGreaterThan(0);
	});

	it("stops ticking when fully caught up", () => {
		const sink = makeSink();
		const { tw, renders } = makeTypewriter(sink);
		tw.receive("hi");

		vi.advanceTimersByTime(500);
		const countAfterCatchup = renders.length;

		vi.advanceTimersByTime(500); // no more content
		expect(renders.length).toBe(countAfterCatchup); // no extra renders
	});

	it("drains quickly after markStreamDone", () => {
		const sink = makeSink();
		const { tw } = makeTypewriter(sink, { intervals: { slowMs: 32, normalMs: 16, fastMs: 8 } });
		tw.receive("a".repeat(20));
		tw.markStreamDone();

		vi.advanceTimersByTime(50); // a few fast ticks at 8ms
		expect(sink.value.length).toBeGreaterThan(15); // draining fast
	});

	it("resumes ticking when new chunks arrive mid-flight", () => {
		const sink = makeSink();
		const { tw } = makeTypewriter(sink);
		tw.receive("hi");

		vi.advanceTimersByTime(500); // caught up
		expect(sink.value).toBe("hi");

		tw.receive(" world"); // new content
		vi.advanceTimersByTime(500);
		expect(sink.value).toBe("hi world");
	});
});

describe("Typewriter — flush and reset", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("flush reveals all pending content immediately", () => {
		const sink = makeSink();
		const { tw } = makeTypewriter(sink);
		tw.receive("hello world");
		tw.flush();
		expect(sink.value).toBe("hello world");
	});

	it("flush cancels the pending tick", () => {
		const sink = makeSink();
		const { tw, renders } = makeTypewriter(sink);
		tw.receive("hi");
		tw.flush();
		const countAfterFlush = renders.length;
		vi.advanceTimersByTime(500);
		expect(renders.length).toBe(countAfterFlush);
	});

	it("reset wipes displayed and pending after flushing", () => {
		const sink = makeSink();
		const { tw } = makeTypewriter(sink);
		tw.receive("hello");
		tw.reset();
		expect(tw.pressure).toBe(0);
		vi.advanceTimersByTime(500);
		expect(sink.value).toBe("hello"); // flushed before reset
	});
});

describe("Typewriter — whenDrained", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("resolves immediately when pressure is zero", async () => {
		const { tw } = makeTypewriter(makeSink());
		await expect(tw.whenDrained()).resolves.toBeUndefined();
	});

	it("resolves after buffer is fully revealed", async () => {
		const sink = makeSink();
		const { tw } = makeTypewriter(sink);
		tw.receive("hello");
		tw.markStreamDone();

		const drained = tw.whenDrained();
		vi.advanceTimersByTime(500);
		await expect(drained).resolves.toBeUndefined();
		expect(sink.value).toBe("hello");
	});

	it("multiple whenDrained calls all resolve", async () => {
		const { tw } = makeTypewriter(makeSink());
		tw.receive("abc");
		tw.markStreamDone();

		const [a, b] = [tw.whenDrained(), tw.whenDrained()];
		vi.advanceTimersByTime(500);
		await expect(Promise.all([a, b])).resolves.toBeDefined();
	});

	it("reset clears pending drainedCallbacks", async () => {
		const { tw } = makeTypewriter(makeSink());
		tw.receive("abc");
		let resolved = false;
		const p = tw.whenDrained().then(() => {
			resolved = true;
		});
		tw.reset(); // clears callbacks
		vi.advanceTimersByTime(500);
		// Promise is orphaned — it won't resolve after reset
		expect(resolved).toBe(false);
		void p; // prevent unhandled rejection lint
	});
});

describe("Typewriter — SOLID: TypewriterSink abstraction (DIP)", () => {
	it("works with any object implementing setText", () => {
		const log: string[] = [];
		const fakeSink: TypewriterSink = { setText: (t) => log.push(t) };
		const tw = new Typewriter(fakeSink, () => {});
		tw.receive("abc");
		tw.flush();
		expect(log.at(-1)).toBe("abc");
	});
});
