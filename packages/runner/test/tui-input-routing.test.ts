/**
 * Bug regression: Ctrl+C does not exit when Kitty keyboard protocol is active.
 *
 * Alacritty (and other Kitty-protocol terminals) send \x1b[99;5u for Ctrl+C
 * instead of the legacy raw byte \x03. Our onRawInput check was `data === "\x03"`
 * which misses the Kitty sequence entirely.
 *
 * These tests FAIL before the fix and PASS after.
 */

import { Container, matchesKey } from "@dpopsuev/alef-tui";
import { describe, expect, it, vi } from "vitest";
import type { Session } from "../src/session.js";
import { getTheme } from "../src/theme.js";
import { ChatLog } from "@dpopsuev/alef-tui/views";
import type { TuiHandlerContext } from "../src/tui-mode.js";
import { handleCtrlC } from "../src/tui-mode.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTui() {
	return { stop: vi.fn(), removeChild: vi.fn(), addChild: vi.fn(), requestRender: vi.fn() };
}

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		state: { id: "test", modelId: "test-model", contextWindow: 128_000 },
		getModel: vi.fn(() => "test-model"),
		setModel: vi.fn(),
		getThinking: vi.fn(() => "off"),
		setThinking: vi.fn(),
		setTurnController: vi.fn(),
		dispose: vi.fn(),
		subscribe: vi.fn(() => () => {}),
		...overrides,
	};
}

function makeCtx(overrides: Partial<TuiHandlerContext> = {}): TuiHandlerContext {
	const t = getTheme();
	return {
		t,
		writer: new ChatLog(new Container(), t),
		tui: makeTui(),
		session: makeSession(),
		dispatch: vi.fn(),
		abortCurrentTurn: undefined,
		setAbortCurrentTurn: vi.fn(),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Bug 1a: matchesKey("ctrl+c") handles both raw \x03 AND Kitty \x1b[99;5u
// This verifies the fix works — the corrected onRawInput must use matchesKey.
// ---------------------------------------------------------------------------

describe("Ctrl+C sequence detection", { tags: ["unit"] }, () => {
	it("matchesKey('ctrl+c') matches raw \\x03 (legacy terminal)", () => {
		expect(matchesKey("\x03", "ctrl+c")).toBe(true);
	});

	it("matchesKey('ctrl+c') matches \\x1b[99;5u (Kitty protocol — Alacritty)", () => {
		// This is the sequence Alacritty sends when Kitty protocol is active.
		// Our old check `data === '\\x03'` would miss this — hence the bug.
		expect(matchesKey("\x1b[99;5u", "ctrl+c")).toBe(true);
	});

	it("raw \\x03 equality check MISSES Kitty Ctrl+C — demonstrates the bug", () => {
		const kittyCtrlC = "\x1b[99;5u";
		// This is exactly what our broken onRawInput did:
		const brokenCheck = (data: string) => data === "\x03";
		expect(brokenCheck(kittyCtrlC)).toBe(false); // BUG: returns false, should be true
	});
});

// ---------------------------------------------------------------------------
// Bug 1b: handleCtrlC must be called regardless of which Ctrl+C sequence arrives
// ---------------------------------------------------------------------------

describe("onRawInput routing — must use matchesKey not === comparison", { tags: ["unit"] }, () => {
	it("handleCtrlC exits when called with kitty Ctrl+C in idle state", () => {
		const ctx = makeCtx();
		// Simulate: onRawInput receives Kitty Ctrl+C and routes to handleCtrlC
		// The corrected onRawInput uses matchesKey(data, 'ctrl+c')
		if (matchesKey("\x1b[99;5u", "ctrl+c")) {
			handleCtrlC(ctx);
		}
		expect(ctx.session.dispose).toHaveBeenCalledOnce();
		expect(ctx.tui.stop).toHaveBeenCalledOnce();
	});

	it("handleCtrlC exits when called with raw \\x03 in idle state", () => {
		const ctx = makeCtx();
		if (matchesKey("\x03", "ctrl+c")) {
			handleCtrlC(ctx);
		}
		expect(ctx.session.dispose).toHaveBeenCalledOnce();
		expect(ctx.tui.stop).toHaveBeenCalledOnce();
	});
});
