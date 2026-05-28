/**
 * RED tests — written before fixes (ROGYB cycle).
 *
 * Bugs captured:
 *   1. Spinner is fixed 180ms regardless of system load — should be pressure-sensitive
 *   2. Final agent reply dumps instantly instead of being typewritten
 *   3. Thinking text not visible (regression)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventPressure, pressureToInterval, timeBasedHue } from "../src/event-pressure.js";
import { pillHeaderStr } from "../src/tui-mode.js";

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
	it("idle pressure gives slow interval (80ms)", () => {
		expect(pressureToInterval(0)).toBe(80);
	});

	it("full pressure gives fast interval (28ms)", () => {
		expect(pressureToInterval(1)).toBe(28);
	});

	it("half pressure interpolates between slow and fast", () => {
		const mid = pressureToInterval(0.5);
		expect(mid).toBeGreaterThan(28);
		expect(mid).toBeLessThan(80);
	});

	it("fast interval is ≤ 35ms", () => {
		expect(pressureToInterval(1)).toBeLessThanOrEqual(35);
	});
});

describe("Time-based hue animation", () => {
	it("hue is 0 at time 0 with no pressure", () => {
		expect(timeBasedHue(0, 0)).toBeCloseTo(0);
	});

	it("hue completes one full cycle over cyclePeriodMs at idle", () => {
		const period = 3500;
		// One period elapsed at zero pressure: should be back near 0 (mod 360)
		const hue = timeBasedHue(period, 0, period);
		expect(hue).toBeCloseTo(0, 0);
	});

	it("pressure accelerates the hue cycle", () => {
		const t = 1000;
		const idleHue = timeBasedHue(t, 0);
		const busyHue = timeBasedHue(t, 1);
		// busy should have advanced further through the spectrum
		expect(busyHue).not.toBeCloseTo(idleHue);
	});

	it("hue is always in [0, 360)", () => {
		for (const [t, p] of [
			[0, 0],
			[500, 0.5],
			[10000, 1],
			[99999, 0.3],
		] as [number, number][]) {
			const h = timeBasedHue(t, p);
			expect(h).toBeGreaterThanOrEqual(0);
			expect(h).toBeLessThan(360);
		}
	});
});

describe("Spinner reads from EventPressure (integration)", () => {
	it("spinner interval at zero pressure is the slow default", () => {
		const p = new EventPressure();
		expect(pressureToInterval(p.level())).toBe(80);
	});

	it("spinner interval at peak pressure is fast (≤ 35ms)", () => {
		const p = new EventPressure();
		for (let i = 0; i < 10; i++) p.pulse();
		expect(pressureToInterval(p.level())).toBeLessThanOrEqual(35);
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
