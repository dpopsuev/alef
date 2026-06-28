/**
 * Typewriter tick isolation test — does the timer fire in test environment?
 */

import { describe, expect, it } from "vitest";
import { Typewriter } from "../src/views/typewriter.js";

describe("Typewriter timer", { tags: ["unit"] }, () => {
	it("tick fires and calls downstream within 100ms", async () => {
		const received: string[] = [];
		let renderCalled = 0;

		const tw = new Typewriter(
			(delta) => received.push(delta),
			() => { renderCalled++; },
		);

		tw.receive("hello world");

		// Wait for ticks (16ms each, 1-8 chars per tick)
		await new Promise((r) => setTimeout(r, 200));


		expect(received.length).toBeGreaterThan(0);
		expect(received.join("")).toBe("hello world");
	});

	it("flush() drains all pending chars instantly", () => {
		const received: string[] = [];
		const tw = new Typewriter(
			(delta) => received.push(delta),
			() => {},
		);

		tw.receive("instant");
		tw.flush();

		expect(received.join("")).toBe("instant");
	});
});
