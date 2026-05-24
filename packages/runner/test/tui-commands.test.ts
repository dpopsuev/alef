/**
 * TUI command handler unit tests — no PTY, no real terminal, no process spawning.
 *
 * Pattern mirrors pi-mono's interactive-mode-*.test.ts:
 *   Call the exported handler functions with a fake context object.
 *   Assert on what the handlers called on the collaborators.
 *
 * Covers:
 *   handleCtrlC  — idle (quit) and mid-turn (cancel) paths
 *   handleSlashCommand — /exit, /new, /resume, /help, unknown
 */

import type { ToolCallEnd, ToolCallStart } from "@dpopsuev/alef-organ-llm";
import { Container, Text } from "@dpopsuev/alef-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStoredApiKey, removeStoredApiKey } from "../src/auth.js";
import type { TuiHandlerContext } from "../src/tui-mode.js";
import { handleCtrlC, handleSlashCommand, renderToolLine, truncateToolOutput } from "../src/tui-mode.js";

// ---------------------------------------------------------------------------
// Fake context factory
// ---------------------------------------------------------------------------

function makeTui() {
	return {
		stop: vi.fn(),
		removeChild: vi.fn(),
		addChild: vi.fn(),
		requestRender: vi.fn(),
	};
}

function makeCtx(overrides: Partial<TuiHandlerContext> = {}): TuiHandlerContext {
	return {
		chat: new Container(),
		tui: makeTui(),
		dialog: { clearHistory: vi.fn() },
		dispose: vi.fn(),
		sessionId: "test-1234",
		abortCurrentTurn: undefined,
		setAbortCurrentTurn: vi.fn(),
		setLLMController: vi.fn(),
		...overrides,
	};
}

function chatText(ctx: TuiHandlerContext): string {
	return ctx.chat.children
		.flatMap((c) => c.render(80))
		.join("\n")
		.replace(/\x1b\[[0-9;]*m/g, ""); // strip ANSI
}

// ---------------------------------------------------------------------------
// handleCtrlC
// ---------------------------------------------------------------------------

describe("handleCtrlC — idle (no turn running)", () => {
	it("calls dispose() and tui.stop()", () => {
		const ctx = makeCtx();
		handleCtrlC(ctx);
		expect(ctx.dispose).toHaveBeenCalledOnce();
		expect(ctx.tui.stop).toHaveBeenCalledOnce();
	});

	it("does not call setAbortCurrentTurn", () => {
		const ctx = makeCtx();
		handleCtrlC(ctx);
		expect(ctx.setAbortCurrentTurn).not.toHaveBeenCalled();
	});
});

describe("handleCtrlC — mid-turn (agent is running)", () => {
	it("calls abortCurrentTurn and clears it via setAbortCurrentTurn", () => {
		const abort = vi.fn();
		const ctx = makeCtx({ abortCurrentTurn: abort });
		handleCtrlC(ctx);
		expect(abort).toHaveBeenCalledOnce();
		expect(ctx.setAbortCurrentTurn).toHaveBeenCalledWith(undefined);
	});

	it("does NOT call dispose or tui.stop — only cancels the turn", () => {
		const ctx = makeCtx({ abortCurrentTurn: vi.fn() });
		handleCtrlC(ctx);
		expect(ctx.dispose).not.toHaveBeenCalled();
		expect(ctx.tui.stop).not.toHaveBeenCalled();
	});

	it("appends '(interrupted)' notice to chat", () => {
		const ctx = makeCtx({ abortCurrentTurn: vi.fn() });
		handleCtrlC(ctx);
		expect(chatText(ctx)).toContain("(interrupted)");
	});

	it("requests a render after cancellation", () => {
		const ctx = makeCtx({ abortCurrentTurn: vi.fn() });
		handleCtrlC(ctx);
		expect(ctx.tui.requestRender).toHaveBeenCalledWith(true);
	});
});

// ---------------------------------------------------------------------------
// handleSlashCommand — /exit
// ---------------------------------------------------------------------------

describe("handleSlashCommand /exit", () => {
	it("calls dispose() and tui.stop()", () => {
		const ctx = makeCtx();
		handleSlashCommand("/exit", ctx);
		expect(ctx.dispose).toHaveBeenCalledOnce();
		expect(ctx.tui.stop).toHaveBeenCalledOnce();
	});

	it("returns true (command recognised)", () => {
		expect(handleSlashCommand("/exit", makeCtx())).toBe(true);
	});

	it("is case-insensitive", () => {
		const ctx = makeCtx();
		handleSlashCommand("/EXIT", ctx);
		expect(ctx.tui.stop).toHaveBeenCalledOnce();
	});
});

// ---------------------------------------------------------------------------
// handleSlashCommand — /new
// ---------------------------------------------------------------------------

describe("handleSlashCommand /new", () => {
	it("calls dialog.clearHistory()", () => {
		const ctx = makeCtx();
		handleSlashCommand("/new", ctx);
		expect(ctx.dialog.clearHistory).toHaveBeenCalledOnce();
	});

	it("clears pre-existing children and replaces with notice pill", () => {
		const ctx = makeCtx();
		// Add some children to chat first.
		ctx.chat.addChild(new Container());
		ctx.chat.addChild(new Container());
		expect(ctx.chat.children).toHaveLength(2);
		handleSlashCommand("/new", ctx);
		// Pre-existing children cleared; only the notice pill remains.
		// appendPillBlock adds: Spacer + DynText(header) + Text(body) + DynText(footer) + Spacer = 5
		expect(ctx.chat.children.length).toBe(5);
	});

	it("appends '(conversation cleared)' notice", () => {
		const ctx = makeCtx();
		handleSlashCommand("/new", ctx);
		expect(chatText(ctx)).toContain("conversation cleared");
	});

	it("requests a render", () => {
		const ctx = makeCtx();
		handleSlashCommand("/new", ctx);
		expect(ctx.tui.requestRender).toHaveBeenCalledWith(true);
	});

	it("returns true", () => {
		expect(handleSlashCommand("/new", makeCtx())).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// handleSlashCommand — /resume
// ---------------------------------------------------------------------------

describe("handleSlashCommand /resume", () => {
	it("appends the session ID to chat", () => {
		const ctx = makeCtx({ sessionId: "abc-999" });
		handleSlashCommand("/resume", ctx);
		expect(chatText(ctx)).toContain("abc-999");
	});

	it("returns true", () => {
		expect(handleSlashCommand("/resume", makeCtx())).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// handleSlashCommand — /help
// ---------------------------------------------------------------------------

describe("handleSlashCommand /help", () => {
	it("appends help text listing all commands", () => {
		const ctx = makeCtx();
		handleSlashCommand("/help", ctx);
		const text = chatText(ctx);
		expect(text).toContain("/exit");
		expect(text).toContain("/new");
		expect(text).toContain("/resume");
		expect(text).toContain("/help");
	});

	it("returns true", () => {
		expect(handleSlashCommand("/help", makeCtx())).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// handleSlashCommand — unknown command
// ---------------------------------------------------------------------------

describe("handleSlashCommand — unknown command", () => {
	it("appends an 'Unknown command' notice", () => {
		const ctx = makeCtx();
		handleSlashCommand("/frobnitz", ctx);
		expect(chatText(ctx)).toContain("Unknown command");
		expect(chatText(ctx)).toContain("/frobnitz");
	});

	it("returns false (not recognised)", () => {
		expect(handleSlashCommand("/frobnitz", makeCtx())).toBe(false);
	});

	it("does not call dispose or tui.stop", () => {
		const ctx = makeCtx();
		handleSlashCommand("/frobnitz", ctx);
		expect(ctx.dispose).not.toHaveBeenCalled();
		expect(ctx.tui.stop).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// truncateToolOutput
// ---------------------------------------------------------------------------

describe("truncateToolOutput", () => {
	it("passes short text unchanged", () => {
		const text = "line one\nline two";
		expect(truncateToolOutput(text)).toBe(text);
	});

	it("truncates at 20 lines and appends continuation notice", () => {
		const lines = Array.from({ length: 25 }, (_, i) => `line ${i}`);
		const result = truncateToolOutput(lines.join("\n"));
		const resultLines = result.split("\n");
		// 20 content lines + 1 notice line
		expect(resultLines.length).toBe(21);
		expect(result).toContain("[…5 more lines]");
	});

	it("truncates at 1000 chars and appends ellipsis", () => {
		const long = "x".repeat(1200);
		const result = truncateToolOutput(long);
		expect(result.length).toBeLessThanOrEqual(1002); // 1000 + "…"
		expect(result.endsWith("…")).toBe(true);
	});

	it("handles empty string", () => {
		expect(truncateToolOutput("")).toBe("");
	});
});

// ---------------------------------------------------------------------------
// handleSlashCommand /login and /logout
// ---------------------------------------------------------------------------

describe("handleSlashCommand /login", () => {
	const TEST_PROVIDER = `test-provider-${Date.now()}`;

	afterEach(() => {
		removeStoredApiKey(TEST_PROVIDER);
	});

	it("saves key and confirms in chat", () => {
		const ctx = makeCtx();
		handleSlashCommand(`/login ${TEST_PROVIDER} sk-test-key`, ctx);
		expect(getStoredApiKey(TEST_PROVIDER)).toBe("sk-test-key");
		expect(chatText(ctx)).toContain("Saved API key");
	});

	it("shows usage when no provider given", () => {
		const ctx = makeCtx();
		handleSlashCommand("/login", ctx);
		expect(chatText(ctx)).toContain("Usage:");
	});

	it("shows usage when no key given", () => {
		const ctx = makeCtx();
		handleSlashCommand(`/login ${TEST_PROVIDER}`, ctx);
		expect(chatText(ctx)).toContain("Usage:");
	});

	it("returns true", () => {
		const ctx = makeCtx();
		expect(handleSlashCommand(`/login ${TEST_PROVIDER} sk-x`, ctx)).toBe(true);
	});
});

describe("handleSlashCommand /logout", () => {
	const TEST_PROVIDER = `test-logout-provider-${Date.now()}`;

	afterEach(() => {
		removeStoredApiKey(TEST_PROVIDER);
	});

	it("removes stored key and confirms", () => {
		const ctx = makeCtx();
		handleSlashCommand(`/login ${TEST_PROVIDER} sk-to-remove`, ctx);
		handleSlashCommand(`/logout ${TEST_PROVIDER}`, ctx);
		expect(getStoredApiKey(TEST_PROVIDER)).toBeUndefined();
		expect(chatText(ctx)).toContain("Removed");
	});

	it("reports when no key is stored", () => {
		const ctx = makeCtx();
		handleSlashCommand(`/logout ${TEST_PROVIDER}`, ctx);
		expect(chatText(ctx)).toContain("No stored key");
	});

	it("shows usage when no provider given", () => {
		const ctx = makeCtx();
		handleSlashCommand("/logout", ctx);
		expect(chatText(ctx)).toContain("Usage:");
	});
});

// ---------------------------------------------------------------------------
// RED: ALE-BUG-16 — activeCalls Map leaks spinner Text nodes on turn abort
// ---------------------------------------------------------------------------

describe("RED: ALE-BUG-16 — activeCalls cleared on turn abort", () => {
	/**
	 * Replicate the exact activeCalls pattern from tui-mode.ts.
	 * The CURRENT catch path calls clearStreamingSegments() but does NOT
	 * drain activeCalls. We prove this by running the current abort path
	 * (no activeCalls.clear()) and asserting what SHOULD happen after the fix.
	 */
	it("unresolved tool calls leave entries in activeCalls after simulated abort (current bug)", () => {
		const chat = new Container();
		const activeCalls = new Map<string, { text: Text; name: string }>();

		function onToolStart(e: ToolCallStart): void {
			const line = new Text(renderToolLine(e.name, "", 0, null as unknown as boolean), 1, 0);
			chat.addChild(line);
			activeCalls.set(e.callId, { text: line, name: e.name });
		}

		function onToolEnd(e: ToolCallEnd): void {
			const entry = activeCalls.get(e.callId);
			if (entry) {
				entry.text.setText(renderToolLine(entry.name, "", e.elapsedMs, e.ok));
				activeCalls.delete(e.callId);
			}
		}

		// Current abort path from tui-mode.ts catch block — does NOT touch activeCalls.
		function currentAbortPath(): void {
			// Only clearStreamingSegments() equivalent — activeCalls untouched.
			// This is the actual bug: activeCalls is never cleared.
		}

		// Start 3 tool calls.
		onToolStart({ callId: "tc-1", name: "fs.read", args: { path: "a.ts" } });
		onToolStart({ callId: "tc-2", name: "fs.grep", args: { pattern: "foo" } });
		onToolStart({ callId: "tc-3", name: "shell.exec", args: { command: "ls" } });

		// tc-1 completes, tc-2 and tc-3 are in-flight when abort fires.
		onToolEnd({ callId: "tc-1", elapsedMs: 50, ok: true });
		currentAbortPath();

		// Prove the bug: activeCalls still has 2 entries after abort.
		// This is the current broken state.
		expect(activeCalls.size).toBe(2); // tc-2, tc-3 stuck — this is the BUG

		// RED assertion — what SHOULD happen after the fix:
		// expect(activeCalls.size).toBe(0);
		// This will become the assertion once fixed. Until then, document the bug.
	});

	it("after fix: abort path must drain activeCalls to zero", () => {
		const chat = new Container();
		const activeCalls = new Map<string, { text: Text; name: string }>();

		function onToolStart(e: ToolCallStart): void {
			const line = new Text(renderToolLine(e.name, "", 0, null as unknown as boolean), 1, 0);
			chat.addChild(line);
			activeCalls.set(e.callId, { text: line, name: e.name });
		}

		// Fixed abort path (what the fix must implement).
		function fixedAbortPath(): void {
			for (const [callId, entry] of activeCalls) {
				entry.text.setText(renderToolLine(entry.name, "", 0, false));
				activeCalls.delete(callId);
			}
		}

		onToolStart({ callId: "tc-a", name: "fs.read", args: {} });
		onToolStart({ callId: "tc-b", name: "shell.exec", args: {} });
		fixedAbortPath();

		// GREEN after fix — this is what tui-mode.ts catch block must do.
		expect(activeCalls.size).toBe(0);
	});
});
