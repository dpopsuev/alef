import { afterEach, describe, expect, it, vi } from "vitest";
import { StreamingTextBuffer } from "../src/modes/interactive/streaming-buffer.js";

afterEach(() => {
	vi.useRealTimers();
});

describe("StreamingTextBuffer", () => {
	it("emits text immediately on first push when buffer is small", () => {
		const emissions: string[] = [];
		const buf = new StreamingTextBuffer((text) => emissions.push(text));

		buf.push("Hello");

		// Should emit immediately (passthrough mode, < 30 chars)
		expect(emissions.length).toBeGreaterThanOrEqual(1);
		expect(emissions[emissions.length - 1]).toBe("Hello");

		buf.stop();
	});

	it("emits all text on end()", () => {
		const emissions: string[] = [];
		const buf = new StreamingTextBuffer((text) => emissions.push(text));

		buf.push("Short text");
		buf.end();

		expect(emissions[emissions.length - 1]).toBe("Short text");
		buf.stop();
	});

	it("flush() emits all buffered text immediately", () => {
		const emissions: string[] = [];
		const buf = new StreamingTextBuffer((text) => emissions.push(text));

		const longText = "A".repeat(500);
		buf.push(longText);
		buf.flush();

		expect(emissions[emissions.length - 1]).toBe(longText);
		buf.stop();
	});

	it("getFullText() returns the full accumulated text", () => {
		const buf = new StreamingTextBuffer(() => {});

		buf.push("Hello ");
		buf.push("Hello World");

		expect(buf.getFullText()).toBe("Hello World");
		buf.stop();
	});

	it("reset() clears all state", () => {
		const emissions: string[] = [];
		const buf = new StreamingTextBuffer((text) => emissions.push(text));

		buf.push("first");
		buf.reset();

		expect(buf.getFullText()).toBe("");
		expect(buf.getDisplayText()).toBe("");
		buf.stop();
	});

	it("smooths bursty input over time", async () => {
		const emissions: string[] = [];
		const buf = new StreamingTextBuffer((text) => emissions.push(text));

		// Push a large burst
		const bigText = "Word ".repeat(200); // 1000 chars
		buf.push(bigText);

		// First emission should NOT contain all text (smoothing active)
		const firstEmission = emissions[0];
		expect(firstEmission.length).toBeLessThan(bigText.length);

		// Wait for buffer to drain
		await new Promise((resolve) => setTimeout(resolve, 200));

		// More emissions should have happened
		expect(emissions.length).toBeGreaterThan(1);

		// Each successive emission should be longer
		for (let i = 1; i < emissions.length; i++) {
			expect(emissions[i].length).toBeGreaterThanOrEqual(emissions[i - 1].length);
		}

		buf.end();
	});

	it("handles surrogate pairs correctly", () => {
		const emissions: string[] = [];
		const buf = new StreamingTextBuffer((text) => emissions.push(text));

		// Text with emoji (surrogate pairs)
		const text = "Hello 🌍 World 🎉 Done";
		buf.push(text);
		buf.flush();

		const final = emissions[emissions.length - 1];
		expect(final).toBe(text);
		// Verify no broken surrogates
		for (let i = 0; i < final.length; i++) {
			const code = final.charCodeAt(i);
			if (code >= 0xd800 && code <= 0xdbff) {
				// High surrogate must be followed by low surrogate
				expect(final.charCodeAt(i + 1)).toBeGreaterThanOrEqual(0xdc00);
				expect(final.charCodeAt(i + 1)).toBeLessThanOrEqual(0xdfff);
			}
		}
		buf.stop();
	});

	it("incremental pushes accumulate correctly", async () => {
		const emissions: string[] = [];
		const buf = new StreamingTextBuffer((text) => emissions.push(text));

		buf.push("Hello");
		await new Promise((resolve) => setTimeout(resolve, 50));
		buf.push("Hello World");
		await new Promise((resolve) => setTimeout(resolve, 50));
		buf.push("Hello World!");

		buf.end();

		expect(emissions[emissions.length - 1]).toBe("Hello World!");
		buf.stop();
	});

	it("stop() halts emission timer", () => {
		const emissions: string[] = [];
		const buf = new StreamingTextBuffer((text) => emissions.push(text));

		const bigText = "X".repeat(500);
		buf.push(bigText);

		const countAfterPush = emissions.length;
		buf.stop();

		// No more emissions should happen after stop
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				expect(emissions.length).toBe(countAfterPush);
				resolve();
			}, 100);
		});
	});
});
