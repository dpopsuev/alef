/**
 * Thinking-tick render rate tests.
 *
 * Captures the spinner flicker bug: PromptConsole.startThinking() calls
 * tui.requestRender() every 28-80ms, producing a unique status line each
 * tick (braille frame rotates, elapsed time changes). This causes 12-35
 * renders/sec where the dock status line is different every frame.
 *
 * The fix: throttle the thinking tick to a minimum interval (>= 200ms)
 * so frame rotation, elapsed display, and hue quantization all align.
 */

import { Container, Text, TUI } from "@dpopsuev/alef-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../ui/tui/test/virtual-terminal.js";
import { PromptConsole } from "../src/client/console.js";
import { getTheme } from "../src/client/theme.js";

function setup(width = 72, height = 18) {
	const terminal = new VirtualTerminal(width, height);
	const renderCalls: number[] = [];
	const tui = new TUI(terminal);

	const origRequest = tui.requestRender.bind(tui);
	tui.requestRender = (force?: boolean) => {
		renderCalls.push(Date.now());
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

	const console = new PromptConsole(tui, getTheme(), "test-model");
	console.mount();

	return { tui, console, renderCalls, cleanup: () => tui.stop() };
}

describe("thinking tick rate", { tags: ["unit"] }, () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("tick interval is at least 150ms at idle pressure", async () => {
		vi.useFakeTimers();
		const { console, renderCalls, cleanup } = setup();

		console.startThinking();

		// Advance 1 second in small steps to trigger all scheduled ticks
		for (let i = 0; i < 50; i++) {
			vi.advanceTimersByTime(20);
		}

		console.stopThinking();
		cleanup();

		// At idle pressure (level=0), pressureToInterval returns slowMs=80.
		// With the fix, the minimum tick interval should be >= 150ms.
		// Bug state: ~12 renders in 1s (80ms interval). Fixed: <= 6 (>= 150ms).
		const tickCount = renderCalls.length;
		expect(
			tickCount,
			`expected <= 8 render calls in 1s (>= 150ms tick), got ${tickCount} (~${Math.round(1000 / tickCount)}ms interval)`,
		).toBeLessThanOrEqual(8);
	});

	it("status text does not produce unique output every 28ms", async () => {
		vi.useFakeTimers();
		const { tui, console, cleanup } = setup();

		// Capture what the status text renders
		const origRequest = tui.requestRender.bind(tui);
		let captureCount = 0;
		tui.requestRender = (force?: boolean) => {
			captureCount++;
			origRequest(force);
		};

		console.startThinking();

		// Simulate 500ms of ticks at maximum pressure (28ms intervals)
		for (let i = 0; i < 18; i++) {
			vi.advanceTimersByTime(28);
		}

		console.stopThinking();
		cleanup();

		// In the bug state, every 28ms tick produces a unique status line
		// because the braille frame and elapsed time both change.
		// With the fix, consecutive ticks within 200ms should produce
		// identical status text.
		// We verify indirectly: total tick count should be low.
		expect(captureCount, `expected <= 5 renders in 504ms, got ${captureCount}`).toBeLessThanOrEqual(5);
	});

	it("elapsed time display is quantized, not raw milliseconds", async () => {
		vi.useFakeTimers();
		const { console, cleanup } = setup();
		const statusTexts: string[] = [];

		// Monkey-patch statusText to capture what gets set
		const origSetText = (console as any).statusText.setText.bind((console as any).statusText);
		(console as any).statusText.setText = (text: string) => {
			if (text) statusTexts.push(text);
			origSetText(text);
		};

		console.startThinking();

		// Run for 600ms
		for (let i = 0; i < 30; i++) {
			vi.advanceTimersByTime(20);
		}

		console.stopThinking();
		cleanup();

		// With quantized elapsed display (200ms steps), we expect at most
		// 3-4 distinct status texts in 600ms. Bug state: 7-21 distinct.
		const unique = new Set(statusTexts);
		expect(
			unique.size,
			`expected <= 5 distinct status texts in 600ms (quantized), got ${unique.size}`,
		).toBeLessThanOrEqual(5);
	});
});
