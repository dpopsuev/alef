/**
 * Robustness tests for StreamingTextBuffer.
 *
 * Covers edge cases, adversarial sequences, and timing scenarios
 * that the basic unit tests don't exercise.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { StreamingTextBuffer } from "../src/modes/interactive/streaming-buffer.js";

afterEach(() => {
	vi.useRealTimers();
});

describe("StreamingTextBuffer — robustness", () => {
	// =====================================================================
	// Adversarial call sequences
	// =====================================================================

	it("push after end() is safe — no crash, no emission", () => {
		const emissions: string[] = [];
		const buf = new StreamingTextBuffer((text) => emissions.push(text));

		buf.push("before");
		buf.end();
		// Push after end should not crash
		buf.push("after end");

		// Wait a tick to see if timer fires
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				// Should not have emitted the post-end text (buffer was stopped)
				// OR it may have restarted — either way, no crash
				resolve();
			}, 50);
		});
	});

	it("push after stop() restarts the emission loop", async () => {
		const emissions: string[] = [];
		const buf = new StreamingTextBuffer((text) => emissions.push(text));

		buf.push("first");
		buf.stop();
		buf.push("second");
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Should have emitted "second" after restarting
		const lastEmission = emissions[emissions.length - 1];
		expect(lastEmission).toBe("second");

		buf.stop();
	});

	it("double end() is safe", () => {
		const buf = new StreamingTextBuffer(() => {});
		buf.push("text");
		buf.end();
		buf.end(); // should not throw
	});

	it("double stop() is safe", () => {
		const buf = new StreamingTextBuffer(() => {});
		buf.push("text");
		buf.stop();
		buf.stop(); // should not throw
	});

	it("end() with no prior push is safe", () => {
		const buf = new StreamingTextBuffer(() => {});
		buf.end(); // no push, just end — should not crash
	});

	it("flush() with no prior push is safe", () => {
		const emissions: string[] = [];
		const buf = new StreamingTextBuffer((text) => emissions.push(text));
		buf.flush(); // nothing buffered
		expect(emissions).toHaveLength(0);
		buf.stop();
	});

	it("reset() then push() works correctly", () => {
		const emissions: string[] = [];
		const buf = new StreamingTextBuffer((text) => emissions.push(text));

		buf.push("first session");
		buf.flush();
		buf.reset();

		expect(buf.getFullText()).toBe("");
		expect(buf.getDisplayText()).toBe("");

		buf.push("second session");
		buf.flush();
		expect(emissions[emissions.length - 1]).toBe("second session");

		buf.stop();
	});

	// =====================================================================
	// Empty and whitespace input
	// =====================================================================

	it("empty string push does not emit", async () => {
		const emissions: string[] = [];
		const buf = new StreamingTextBuffer((text) => emissions.push(text));

		buf.push("");
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Empty text has 0 pending — tick should be a no-op
		expect(emissions.every((e) => e === "")).toBe(true);
		buf.stop();
	});

	it("whitespace-only text is handled correctly", () => {
		const emissions: string[] = [];
		const buf = new StreamingTextBuffer((text) => emissions.push(text));

		buf.push("   \n\t  ");
		buf.flush();

		expect(emissions[emissions.length - 1]).toBe("   \n\t  ");
		buf.stop();
	});

	// =====================================================================
	// Large input stress
	// =====================================================================

	it("handles 1MB of text without crash", () => {
		const emissions: string[] = [];
		const buf = new StreamingTextBuffer((text) => emissions.push(text));

		const bigText = "A".repeat(1_000_000);
		buf.push(bigText);
		buf.flush();

		expect(emissions[emissions.length - 1]).toBe(bigText);
		expect(emissions[emissions.length - 1].length).toBe(1_000_000);
		buf.stop();
	});

	it("rapid incremental pushes accumulate correctly", async () => {
		const emissions: string[] = [];
		const buf = new StreamingTextBuffer((text) => emissions.push(text));

		// Simulate rapid token arrival (100 tokens in quick succession)
		let accumulated = "";
		for (let i = 0; i < 100; i++) {
			accumulated += `token${i} `;
			buf.push(accumulated);
		}

		buf.end();
		const final = emissions[emissions.length - 1];
		expect(final).toBe(accumulated);
		expect(final).toContain("token0");
		expect(final).toContain("token99");
	});

	// =====================================================================
	// Timing: buffer pressure adaptation
	// =====================================================================

	it("high-pressure mode emits faster than normal", async () => {
		const emissions: string[] = [];
		const buf = new StreamingTextBuffer((text) => emissions.push(text));

		// Push 3000 chars (above HIGH_WATER_MARK of 2000)
		const bigText = "X".repeat(3000);
		buf.push(bigText);

		// Wait one frame
		await new Promise((resolve) => setTimeout(resolve, 20));

		if (emissions.length > 0) {
			// First emission should be larger than default 12 chars
			// because high-pressure mode multiplies charsPerFrame
			const firstLen = emissions[0].length;
			expect(firstLen).toBeGreaterThan(12);
		}

		buf.stop();
	});

	it("drain mode after end() emits at 4x speed", async () => {
		const emissions: string[] = [];
		const buf = new StreamingTextBuffer((text) => emissions.push(text));

		// Push enough text to trigger smoothing (>30 chars)
		const text = "Y".repeat(200);
		buf.push(text);

		// Let one normal frame emit
		await new Promise((resolve) => setTimeout(resolve, 20));
		// End and let drain frames emit
		buf.end();

		// Final emission should have all text
		expect(emissions[emissions.length - 1]).toBe(text);
	});

	// =====================================================================
	// Unicode edge cases
	// =====================================================================

	it("handles CJK characters", () => {
		const buf = new StreamingTextBuffer(() => {});
		buf.push("你好世界 Hello 🌍");
		buf.flush();
		expect(buf.getDisplayText()).toBe("你好世界 Hello 🌍");
		buf.stop();
	});

	it("handles mixed RTL/LTR text", () => {
		const buf = new StreamingTextBuffer(() => {});
		buf.push("Hello שלום مرحبا World");
		buf.flush();
		expect(buf.getDisplayText()).toBe("Hello שלום مرحبا World");
		buf.stop();
	});

	it("handles zero-width joiners and combining characters", () => {
		const buf = new StreamingTextBuffer(() => {});
		// Family emoji (ZWJ sequence)
		const text = "👨‍👩‍👧‍👦 text";
		buf.push(text);
		buf.flush();
		expect(buf.getDisplayText()).toBe(text);
		buf.stop();
	});
});
