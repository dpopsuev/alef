/**
 * RED tests — written before fixes (ROGYB cycle).
 *
 * Bugs captured:
 *   1. Spinner is fixed 180ms regardless of system load — should be pressure-sensitive
 *   2. Final agent reply dumps instantly instead of being typewritten
 *   3. Thinking text not visible (regression)
 */

import { Container, Text } from "@dpopsuev/alef-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventPressure, pressureToHueShift, pressureToInterval } from "../src/event-pressure.js";
import { pillHeaderStr } from "../src/tui-mode.js";
import { Typewriter } from "../src/typewriter.js";

// ---------------------------------------------------------------------------
// 1. Pressure-sensitive spinner
// ---------------------------------------------------------------------------

describe("EventPressure gauge", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("starts at zero pressure", () => {
		const p = new EventPressure();
		expect(p.level()).toBe(0);
	});

	it("raises level after a pulse", () => {
		const p = new EventPressure();
		p.pulse();
		expect(p.level()).toBeGreaterThan(0);
	});

	it("level stays ≤ 1 after many pulses", () => {
		const p = new EventPressure();
		for (let i = 0; i < 20; i++) p.pulse();
		expect(p.level()).toBeLessThanOrEqual(1);
	});

	it("decays to zero after silence exceeds half-lives", () => {
		const p = new EventPressure(100);
		p.pulse();
		expect(p.level()).toBeGreaterThan(0);
		vi.advanceTimersByTime(700); // 7 half-lives → ~1% remaining
		expect(p.level()).toBeLessThan(0.02);
	});

	it("multiple pulses in quick succession saturate faster", () => {
		const p = new EventPressure();
		p.pulse();
		const afterOne = p.level();
		p.pulse();
		p.pulse();
		expect(p.level()).toBeGreaterThan(afterOne);
	});
});

describe("Pressure → spinner interval mapping", () => {
	it("idle pressure gives slow interval", () => {
		expect(pressureToInterval(0)).toBe(160);
	});

	it("full pressure gives fast interval", () => {
		expect(pressureToInterval(1)).toBe(55);
	});

	it("half pressure interpolates", () => {
		const mid = pressureToInterval(0.5);
		expect(mid).toBeGreaterThan(55);
		expect(mid).toBeLessThan(160);
	});

	it("fast interval is ≤ 80ms", () => {
		expect(pressureToInterval(1)).toBeLessThanOrEqual(80);
	});
});

describe("Pressure → hue shift mapping", () => {
	it("zero pressure gives zero hue shift", () => {
		expect(pressureToHueShift(0)).toBe(0);
	});

	it("full pressure gives maximum hue shift", () => {
		expect(pressureToHueShift(1, 80)).toBe(80);
	});

	it("partial pressure gives proportional shift", () => {
		expect(pressureToHueShift(0.5, 80)).toBeCloseTo(40);
	});
});

describe("Spinner reads from EventPressure (integration)", () => {
	it("spinner interval at zero pressure is slow (≥ 140ms)", () => {
		const p = new EventPressure();
		expect(pressureToInterval(p.level())).toBeGreaterThanOrEqual(140);
	});

	it("spinner interval at peak pressure is fast (≤ 80ms)", () => {
		const p = new EventPressure();
		for (let i = 0; i < 10; i++) p.pulse();
		expect(pressureToInterval(p.level())).toBeLessThanOrEqual(80);
	});
});

// ---------------------------------------------------------------------------
// 2. Final reply typewriting
// ---------------------------------------------------------------------------

describe("Agent reply is typewritten, not dumped", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("body text starts empty and reveals gradually", () => {
		const sink = {
			value: "",
			setText(t: string) {
				this.value = t;
			},
		};
		const tw = new Typewriter(sink, () => {}, { tickMs: 4 });
		const reply = "Based on my exploration, the codebase follows an EDA architecture.";

		tw.receive(reply);
		tw.markStreamDone();

		expect(sink.value).toBe("");

		vi.advanceTimersByTime(6); // one 4ms tick fires, partial drain
		expect(sink.value.length).toBeGreaterThan(0);
		expect(sink.value.length).toBeLessThan(reply.length);

		vi.advanceTimersByTime(500);
		expect(sink.value).toBe(reply);
	});
});

// ---------------------------------------------------------------------------
// 3. Thinking visibility
// ---------------------------------------------------------------------------

describe("Thinking text appears during extended thinking", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("thinking chunk is revealed by thinkTypewriter", () => {
		const sink = {
			value: "",
			setText(t: string) {
				this.value = t;
			},
		};
		const tw = new Typewriter(sink, () => {});
		const chunk = "Analyzing the repository structure to understand the architecture...";

		tw.receive(chunk);
		tw.markStreamDone();
		vi.advanceTimersByTime(2000); // 68 chars / 2 per tick / 60fps = ~544ms, give margin

		expect(sink.value).toBe(chunk);
	});

	it("thinking segment gets a label node and a content node", () => {
		const segment = new Container();
		segment.addChild(new Text("…thinking", 2, 0));
		const contentNode = new Text("", 2, 0);
		segment.addChild(contentNode);

		expect(segment.children.length).toBe(2);
		expect(segment.children[0]).toBeInstanceOf(Text);
	});
});

// ---------------------------------------------------------------------------
// Pill alignment regression guard
// ---------------------------------------------------------------------------

describe("Pill alignment (regression)", () => {
	it("@alef header matches footer width at 80 columns", () => {
		const header = pillHeaderStr("@alef", 80);
		const footer = `╰${"─".repeat(78)}╯`;
		expect(header.length).toBe(footer.length);
	});
});
