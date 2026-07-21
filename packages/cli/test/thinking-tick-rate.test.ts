/**
 * Thinking-tick render rate tests.
 *
 * Original bug: PromptConsole.startThinking() called requestRender() on
 * every 28-80ms tick because the status string was unique each time --
 * raw millisecond elapsed display changed every tick, braille frame
 * rotated every tick, and hue shifted every tick.
 *
 * Fix: dirty-check the composed status string before calling requestRender().
 * Braille rotates at 80ms, hue at 200ms, elapsed at 1s. The tick fires
 * fast (pressureToInterval) for responsive animation but skips renders
 * when the output is identical to the previous frame.
 */

import { Container, Text, TUI } from "@dpopsuev/alef-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../ui/tui/test/virtual-terminal.js";
import { PromptConsole } from "../src/client/console.js";
import { getTheme } from "../src/client/theme.js";

function setup(width = 72, height = 18) {
	const terminal = new VirtualTerminal(width, height);
	const tui = new TUI(terminal);

	let renderCount = 0;
	const origRequest = tui.requestRender.bind(tui);
	tui.requestRender = (force?: boolean) => {
		renderCount++;
		origRequest(force);
	};

	terminal.start(
		() => {},
		() => {},
	);
	tui.start();

	const chat = new Container();
	tui.addChild(chat);
	for (let i = 0; i < 6; i++) chat.addChild(new Text(`msg-${i}`, 0, 0));

	const pc = new PromptConsole(tui, getTheme(), "test-model");
	pc.mount();

	return {
		tui,
		pc,
		getRenderCount: () => renderCount,
		resetRenderCount: () => {
			renderCount = 0;
		},
		cleanup: () => tui.stop(),
	};
}

describe("thinking tick rate", { tags: ["unit"] }, () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("dirty-check suppresses renders when status text is unchanged", async () => {
		vi.useFakeTimers();
		const { pc, getRenderCount, resetRenderCount, cleanup } = setup();

		pc.startThinking();
		// First tick fires after 80ms at idle pressure
		vi.advanceTimersByTime(80);
		resetRenderCount();

		// Advance in tiny steps within the same 80ms braille window.
		// The dirty-check should prevent any new renders since the
		// composed string (same frame, same hue, same elapsed) is identical.
		for (let i = 0; i < 5; i++) {
			vi.advanceTimersByTime(10);
		}

		pc.stopThinking();
		cleanup();

		expect(getRenderCount(), "renders within the same braille frame window should be suppressed by dirty-check").toBe(
			0,
		);
	});

	it("elapsed display uses 1-second quantization, not raw milliseconds", async () => {
		vi.useFakeTimers();
		const { pc, cleanup } = setup();
		const statusTexts: string[] = [];

		const origSetText = (pc as any).statusText.setText.bind((pc as any).statusText);
		(pc as any).statusText.setText = (text: string) => {
			if (text) statusTexts.push(text);
			origSetText(text);
		};

		pc.startThinking();

		// Run for 1500ms -- should see elapsed change only at 0s and 1s boundaries
		for (let i = 0; i < 75; i++) {
			vi.advanceTimersByTime(20);
		}

		pc.stopThinking();
		cleanup();

		// Extract elapsed text (strip ANSI, find the duration token)
		const elapsedValues = new Set(
			statusTexts.map((t) => {
				const stripped = t.replace(/\x1b\[[0-9;]*m/g, "").trim();
				const match = stripped.match(/\d+(?:\.\d+)?(?:ms|s|m)/);
				return match?.[0] ?? "";
			}),
		);

		// With 1s quantization over 1500ms we expect exactly 2 distinct
		// elapsed values: "0ms" (or "0s") and "1.0s"
		expect(
			elapsedValues.size,
			`expected 2 distinct elapsed values in 1.5s, got ${elapsedValues.size}: ${[...elapsedValues].join(", ")}`,
		).toBeLessThanOrEqual(2);
	});

	it("braille frame rotates at 80ms for smooth animation", async () => {
		vi.useFakeTimers();
		const { pc, cleanup } = setup();
		const statusTexts: string[] = [];

		const origSetText = (pc as any).statusText.setText.bind((pc as any).statusText);
		(pc as any).statusText.setText = (text: string) => {
			if (text) statusTexts.push(text);
			origSetText(text);
		};

		pc.startThinking();

		// Run for 800ms (one full braille cycle of 10 frames at 80ms each)
		for (let i = 0; i < 40; i++) {
			vi.advanceTimersByTime(20);
		}

		pc.stopThinking();
		cleanup();

		// Extract braille characters
		const braillePattern = /[\u2800-\u28FF]/;
		const frames = statusTexts.map((t) => t.match(braillePattern)?.[0]).filter((f): f is string => f !== undefined);

		const uniqueFrames = new Set(frames);

		// Over 800ms at 80ms per frame, we should see all 10 distinct braille chars
		expect(uniqueFrames.size, `expected 10 distinct braille frames in 800ms, got ${uniqueFrames.size}`).toBe(10);
	});

	it("total render count stays bounded despite fast ticks", async () => {
		vi.useFakeTimers();
		const { pc, getRenderCount, resetRenderCount, cleanup } = setup();

		pc.startThinking();
		// Let first tick establish baseline
		vi.advanceTimersByTime(80);
		resetRenderCount();

		// Run for 1 second
		for (let i = 0; i < 50; i++) {
			vi.advanceTimersByTime(20);
		}

		pc.stopThinking();
		cleanup();

		// Braille changes every 80ms = ~12.5 distinct frames/sec.
		// Hue changes every 200ms. Combined, the upper bound on unique
		// composed strings is ~12-13 per second. Allow headroom.
		const count = getRenderCount();
		expect(count, `expected <= 15 renders in 1s (dirty-checked), got ${count}`).toBeLessThanOrEqual(15);
	});
});
