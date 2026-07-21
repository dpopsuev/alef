/**
 * Spinner flicker and duplication tests.
 *
 * These tests catch three structural rendering bugs:
 *
 *   1. Duplicate spinner lines -- thinking spinner and agent card both show
 *      braille characters in the dock zone, looking like duplicate spinners
 *      when a single subagent is in flight.
 *
 *   2. Compound tick -- one timer updates the thinking spinner AND refreshes
 *      all agent cards, causing O(N) component updates per tick instead of
 *      O(1). Each card independently calls spinnerFrame(), so the tick does
 *      work proportional to the number of in-flight calls.
 *
 *   3. No single-spinner invariant -- Pi enforces "at most one active status
 *      indicator" via showStatusIndicator() which disposes the previous one.
 *      Alef has no equivalent constraint.
 *
 * These tests assert on model state and render output, not exact ANSI bytes.
 * Following the lexicon tui-testing principle: "test behavior, not pixels."
 */

import { Container, Text, TUI } from "@dpopsuev/alef-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../ui/tui/test/virtual-terminal.js";
import { DockConsole } from "../src/client/console.js";
import { getTheme } from "../src/client/theme.js";

function setup(width = 80, height = 20) {
	const terminal = new VirtualTerminal(width, height);
	const tui = new TUI(terminal);

	terminal.start(
		() => {},
		() => {},
	);
	tui.start();

	const chat = new Container();
	tui.addChild(chat);
	for (let i = 0; i < 4; i++) chat.addChild(new Text(`msg-${i}`, 0, 0));

	const pc = new DockConsole(tui, getTheme(), "test-model");
	pc.mount();

	return { terminal, tui, pc, chat, cleanup: () => tui.stop() };
}

describe("spinner duplication", { tags: ["unit"] }, () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("viewport has at most one braille spinner line during thinking without subagents", async () => {
		vi.useFakeTimers();
		const { tui, pc, cleanup } = setup();

		tui.requestRender(true);
		vi.advanceTimersByTime(50);

		pc.startThinking();
		vi.advanceTimersByTime(200);

		// Render and capture viewport
		tui.requestRender(true);
		vi.advanceTimersByTime(50);

		// Get the viewport lines from the terminal
		const lines = tui.render(80);
		const braillePattern = /[⠀-⣿]/;
		const brailleLines = lines.filter((l) => braillePattern.test(l));

		expect(
			brailleLines.length,
			`expected at most 1 braille spinner line, got ${brailleLines.length}:\n${brailleLines.join("\n")}`,
		).toBeLessThanOrEqual(1);

		pc.stopThinking();
		cleanup();
	});

	it("viewport has at most one braille spinner line when one subagent is in flight", async () => {
		vi.useFakeTimers();
		const { tui, pc, cleanup } = setup();

		tui.requestRender(true);
		vi.advanceTimersByTime(50);

		pc.startThinking();
		pc.showInFlightCall("call-1", "agent.run", "explore", { text: "test" });
		vi.advanceTimersByTime(200);

		tui.requestRender(true);
		vi.advanceTimersByTime(50);

		const lines = tui.render(80);
		const braillePattern = /[⠀-⣿]/;
		const brailleLines = lines.filter((l) => braillePattern.test(l));

		// Bug: currently produces 2 braille lines (thinking + card).
		// After fix: should be at most 1 (the thinking status subsumes the card spinner).
		// For now we document the bug -- this test should FAIL.
		expect(
			brailleLines.length,
			`expected at most 1 braille spinner line with 1 subagent, got ${brailleLines.length}:\n${brailleLines.join("\n")}`,
		).toBeLessThanOrEqual(1);

		pc.removeInFlightCall("call-1");
		pc.stopThinking();
		cleanup();
	});
});

describe("compound tick efficiency", { tags: ["unit"] }, () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("refreshCards is not called when no in-flight calls exist", async () => {
		vi.useFakeTimers();
		const { pc, cleanup } = setup();

		let refreshCount = 0;
		const origRefresh = (pc as any).refreshCards.bind(pc);
		(pc as any).refreshCards = () => {
			refreshCount++;
			origRefresh();
		};

		pc.startThinking();
		vi.advanceTimersByTime(500);
		pc.stopThinking();
		cleanup();

		// refreshCards walks all in-flight cards. When there are none,
		// it should not be called at all -- it's wasted work.
		expect(refreshCount, `refreshCards called ${refreshCount} times with 0 in-flight calls (should be 0)`).toBe(0);
	});

	it("render count does not grow with the number of in-flight cards", async () => {
		vi.useFakeTimers();
		const { tui, pc, cleanup } = setup();

		// Scenario 1: thinking with 1 card
		let renders1 = 0;
		const orig0 = tui.requestRender.bind(tui);
		tui.requestRender = (force?: boolean) => {
			renders1++;
			orig0(force);
		};

		pc.startThinking();
		pc.showInFlightCall("a1", "agent.run", "a", {});
		vi.advanceTimersByTime(500);
		pc.removeInFlightCall("a1");
		pc.stopThinking();

		// Scenario 2: thinking with 5 cards
		let renders5 = 0;
		tui.requestRender = (force?: boolean) => {
			renders5++;
			orig0(force);
		};

		pc.startThinking();
		for (let i = 0; i < 5; i++) pc.showInFlightCall(`b${i}`, "agent.run", String(i), {});
		vi.advanceTimersByTime(500);
		for (let i = 0; i < 5; i++) pc.removeInFlightCall(`b${i}`);
		pc.stopThinking();
		cleanup();

		// Adding more cards should not multiply the render count.
		// The tick fires at a fixed rate; more cards just means more work
		// per tick, not more ticks. Allow headroom for show/remove renders.
		const ratio = renders5 / Math.max(1, renders1);
		expect(
			ratio,
			`render count ratio with 5 cards vs 1 card: ${ratio.toFixed(1)}x (${renders5} vs ${renders1})`,
		).toBeLessThan(2);
	});
});

describe("single-spinner invariant", { tags: ["unit"] }, () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("stopThinking clears all animated state", async () => {
		vi.useFakeTimers();
		const { pc, cleanup } = setup();

		pc.startThinking();
		vi.advanceTimersByTime(200);

		expect(pc.isThinking).toBe(true);

		pc.stopThinking();

		expect(pc.isThinking).toBe(false);

		// The status text should be empty
		const statusText = (pc as any).statusText;
		const rendered = statusText.render(80);
		const nonEmpty = rendered.filter((l: string) => l.trim().length > 0);
		expect(nonEmpty.length, "status text should be empty after stopThinking").toBe(0);

		cleanup();
	});

	it("startThinking cancels any previous thinking timer", async () => {
		vi.useFakeTimers();
		const { tui, pc, cleanup } = setup();

		let renderCount = 0;
		const orig = tui.requestRender.bind(tui);
		tui.requestRender = (force?: boolean) => {
			renderCount++;
			orig(force);
		};

		// Start thinking twice without stopping
		pc.startThinking();
		pc.startThinking();

		vi.advanceTimersByTime(500);
		pc.stopThinking();
		cleanup();

		// Should have the same render count as a single startThinking call,
		// not double (which would mean two timers running).
		// At 80ms frame rotation over 500ms: ~6 frames. Allow headroom.
		expect(
			renderCount,
			`double startThinking produced ${renderCount} renders (should be <=12, not doubled)`,
		).toBeLessThanOrEqual(12);
	});

	it("agent cards do not animate independently of the thinking tick", async () => {
		vi.useFakeTimers();
		const { tui, pc, cleanup } = setup();

		// Show a card WITHOUT starting thinking
		pc.showInFlightCall("c1", "agent.run", "explore", {});

		// Start counting AFTER the initial show-card render
		let renderCount = 0;
		const orig = tui.requestRender.bind(tui);
		tui.requestRender = (force?: boolean) => {
			renderCount++;
			orig(force);
		};

		// Advance time -- card should NOT animate on its own
		vi.advanceTimersByTime(500);

		cleanup();

		// Cards have no independent timer. They only update when
		// refreshCards() is called from the thinking tick.
		// With no thinking active, render count should be 0 from animation.
		expect(renderCount, `card produced ${renderCount} animation renders without thinking active (should be 0)`).toBe(
			0,
		);
	});
});
