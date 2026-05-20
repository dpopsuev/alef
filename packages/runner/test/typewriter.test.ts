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

describe("Smooth reveal while streaming", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("reveals one character at a time when the buffer is nearly empty", () => {
		const { tw } = makeWriter(makeSink());
		tw.receive("ab");
		expect(tw.pressureStep(2)).toBe(1);
		expect(tw.pressureStep(1)).toBe(1);
	});

	it("reveals up to 12 characters per tick when significantly behind", () => {
		const { tw } = makeWriter(makeSink());
		tw.receive("x");
		expect(tw.pressureStep(180)).toBe(12);
		expect(tw.pressureStep(400)).toBe(12);
	});

	it("does not reveal all content in the first tick", () => {
		const sink = makeSink();
		const { tw } = makeWriter(sink);
		tw.receive("hello world");

		vi.advanceTimersByTime(48);
		expect(sink.value.length).toBeGreaterThan(0);
		expect(sink.value.length).toBeLessThan(11);
	});

	it("ticks more slowly when the buffer is nearly caught up", () => {
		const { tw } = makeWriter(makeSink(), { intervals: { slowMs: 32, normalMs: 16, fastMs: 8 } });
		tw.receive("ab");
		expect(tw.nextTickMs()).toBe(32);
	});

	it("ticks faster when the buffer is falling behind", () => {
		const { tw } = makeWriter(makeSink(), { intervals: { slowMs: 32, normalMs: 16, fastMs: 8 } });
		tw.receive("a".repeat(100));
		expect(tw.nextTickMs()).toBe(8);
	});

	it("triggers a render on every tick that produces visible output", () => {
		const sink = makeSink();
		const { tw, renders } = makeWriter(sink);
		tw.receive("abcde");
		vi.advanceTimersByTime(300);
		expect(renders.length).toBeGreaterThan(0);
	});

	it("stops ticking once fully caught up — no unnecessary renders", () => {
		const sink = makeSink();
		const { tw, renders } = makeWriter(sink);
		tw.receive("hi");
		vi.advanceTimersByTime(500);
		const settled = renders.length;
		vi.advanceTimersByTime(500);
		expect(renders.length).toBe(settled);
	});

	it("reveals all content eventually", () => {
		const sink = makeSink();
		const { tw } = makeWriter(sink);
		tw.receive("hello world");
		vi.advanceTimersByTime(1000);
		expect(sink.value).toBe("hello world");
	});

	it("resumes when new content arrives after catching up", () => {
		const sink = makeSink();
		const { tw } = makeWriter(sink);
		tw.receive("hi");
		vi.advanceTimersByTime(500);
		tw.receive(" world");
		vi.advanceTimersByTime(500);
		expect(sink.value).toBe("hi world");
	});
});

describe("Fast drain when the stream has stopped", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("drains half the remaining gap per tick after the stream ends", () => {
		const { tw } = makeWriter(makeSink());
		tw.markStreamDone();
		expect(tw.pressureStep(100)).toBe(50);
		expect(tw.pressureStep(7)).toBe(4);
	});

	it("ticks at the fast interval immediately after the stream ends", () => {
		const { tw } = makeWriter(makeSink(), { intervals: { slowMs: 32, normalMs: 16, fastMs: 8 } });
		tw.receive("ab");
		tw.markStreamDone();
		expect(tw.nextTickMs()).toBe(8);
	});

	it("treats a long silence as stream-done even without explicit signal", () => {
		const { tw } = makeWriter(makeSink(), { streamingPauseMs: 150 });
		tw.receive("hi");
		vi.advanceTimersByTime(151);
		expect(tw.effectivelyDone).toBe(true);
	});

	it("empties the buffer quickly after markStreamDone", () => {
		const sink = makeSink();
		const { tw } = makeWriter(sink, { intervals: { slowMs: 32, normalMs: 16, fastMs: 8 } });
		tw.receive("a".repeat(20));
		tw.markStreamDone();
		vi.advanceTimersByTime(50);
		expect(sink.value.length).toBeGreaterThan(15);
	});
});

describe("Finalization — waiting for the buffer to drain", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("resolves immediately when there is nothing pending", async () => {
		const { tw } = makeWriter(makeSink());
		await expect(tw.whenDrained()).resolves.toBeUndefined();
	});

	it("resolves only after all pending content is revealed", async () => {
		const sink = makeSink();
		const { tw } = makeWriter(sink);
		tw.receive("hello");
		tw.markStreamDone();

		const drained = tw.whenDrained();
		vi.advanceTimersByTime(500);
		await expect(drained).resolves.toBeUndefined();
		expect(sink.value).toBe("hello");
	});

	it("multiple callers all receive the completion signal", async () => {
		const { tw } = makeWriter(makeSink());
		tw.receive("abc");
		tw.markStreamDone();

		const [a, b] = [tw.whenDrained(), tw.whenDrained()];
		vi.advanceTimersByTime(500);
		await expect(Promise.all([a, b])).resolves.toBeDefined();
	});
});

describe("Turn lifecycle — flush and reset", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("flush reveals all pending content immediately", () => {
		const sink = makeSink();
		const { tw } = makeWriter(sink);
		tw.receive("hello world");
		tw.flush();
		expect(sink.value).toBe("hello world");
	});

	it("flush cancels any scheduled tick", () => {
		const sink = makeSink();
		const { tw, renders } = makeWriter(sink);
		tw.receive("hi");
		tw.flush();
		const after = renders.length;
		vi.advanceTimersByTime(500);
		expect(renders.length).toBe(after);
	});

	it("reset clears all state after flushing visible content", () => {
		const sink = makeSink();
		const { tw } = makeWriter(sink);
		tw.receive("hello");
		tw.reset();
		expect(tw.pressure).toBe(0);
		vi.advanceTimersByTime(500);
		expect(sink.value).toBe("hello");
	});
});

describe("Accepting any display target", () => {
	it("works with any object that can receive text", () => {
		const received: string[] = [];
		const tw = new Typewriter({ setText: (t) => received.push(t) }, () => {});
		tw.receive("abc");
		tw.flush();
		expect(received.at(-1)).toBe("abc");
	});
});
