import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Typewriter } from "../../src/views/index.js";

describe("Typewriter middleware", { tags: ["unit"] }, () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("delivers chunks to downstream gradually, not all at once", () => {
		const received: string[] = [];
		const tw = new Typewriter(
			(d) => received.push(d),
			() => {},
			{ tickMs: 16 },
		);

		tw.receive("hello world");
		expect(received).toHaveLength(0); // nothing yet before first tick

		vi.advanceTimersByTime(16);
		expect(received.length).toBeGreaterThan(0);
		expect(received.join("").length).toBeLessThan("hello world".length);
	});

	it("downstream receives the full text eventually", () => {
		const received: string[] = [];
		const tw = new Typewriter(
			(d) => received.push(d),
			() => {},
			{ tickMs: 16 },
		);

		tw.receive("hello world");
		vi.advanceTimersByTime(1000);

		expect(received.join("")).toBe("hello world");
	});

	it("downstream receives delta chunks, not accumulated text", () => {
		const received: string[] = [];
		const tw = new Typewriter(
			(d) => received.push(d),
			() => {},
			{ tickMs: 16, maxCharsPerTick: 2 },
		);

		tw.receive("abcd");
		vi.advanceTimersByTime(16);
		// Each delta should be a substring, not a repeat
		for (const chunk of received) {
			expect(chunk.length).toBeGreaterThan(0);
			expect(chunk.length).toBeLessThanOrEqual(2);
		}
	});

	it("flush() emits all remaining chars instantly", () => {
		const received: string[] = [];
		const tw = new Typewriter(
			(d) => received.push(d),
			() => {},
			{ tickMs: 16 },
		);

		tw.receive("hello world");
		tw.flush();

		expect(received.join("")).toBe("hello world");
	});

	it("flush() then reset() clears state for next turn", () => {
		const received: string[] = [];
		const tw = new Typewriter(
			(d) => received.push(d),
			() => {},
			{ tickMs: 16 },
		);

		tw.receive("turn one");
		tw.reset(); // flush + clear

		tw.receive("turn two");
		vi.advanceTimersByTime(1000);

		expect(received.join("")).toBe("turn oneturn two");
	});

	it("flush() after flush() is a no-op", () => {
		const received: string[] = [];
		const tw = new Typewriter(
			(d) => received.push(d),
			() => {},
		);

		tw.receive("abc");
		tw.flush();
		tw.flush(); // second flush — no duplicate emission

		expect(received.join("")).toBe("abc");
	});

	it("stops ticking once all chars are delivered", () => {
		const renders: number[] = [];
		const tw = new Typewriter(
			() => {},
			() => renders.push(Date.now()),
			{ tickMs: 16 },
		);

		tw.receive("hi");
		vi.advanceTimersByTime(500);
		const settled = renders.length;

		vi.advanceTimersByTime(500);
		expect(renders.length).toBe(settled);
	});
});
