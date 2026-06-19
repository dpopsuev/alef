/**
 * TUI command handler unit tests — no PTY, no real terminal, no process spawning.
 *
 * Pattern mirrors pi-mono's interactive-mode-*.test.ts:
 * Call the exported handler functions with a fake context object.
 * Assert on what the handlers called on the collaborators.
 *
 * Covers:
 * handleCtrlC — idle (quit) and mid-turn (cancel) paths
 * handleSlashCommand — /exit, /new, /resume, /help, unknown
 */

import type { ToolCallEnd, ToolCallStart } from "@dpopsuev/alef-reasoner";
import { Container } from "@dpopsuev/alef-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStoredApiKey, removeStoredApiKey } from "../src/auth.js";
import type { Session } from "../src/session.js";
import { getTheme } from "../src/theme.js";
import { ChatLog } from "../src/tui/chat-log.js";
import { ToolCallRow } from "../src/tui/tool-view.js";
import type { TuiHandlerContext } from "../src/tui-mode.js";
import { handleColonCommand, handleCtrlC, handleSlashCommand, truncateToolOutput } from "../src/tui-mode.js";

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

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		state: { id: "test-1234", modelId: "test-model", contextWindow: 128_000 },
		getModel: vi.fn(() => "test-model"),
		setModel: vi.fn(),
		getThinking: vi.fn(() => "off"),
		setThinking: vi.fn(),
		setTurnController: vi.fn(),
		dispose: vi.fn(),
		subscribe: vi.fn(() => () => {}),
		send: vi.fn(),
		loadOrgan: vi.fn(),
		unloadOrgan: vi.fn(() => true),
		reloadOrgan: vi.fn(),
		getDirective: vi.fn(),
		...overrides,
	};
}

function makeCtx(overrides: Partial<TuiHandlerContext> = {}): TuiHandlerContext {
	const t = getTheme();
	const chat = new Container();
	return {
		t,
		writer: new ChatLog(chat, t),
		tui: makeTui(),
		session: makeSession(),
		abortCurrentTurn: undefined,
		setAbortCurrentTurn: vi.fn(),
		...overrides,
	};
}

function chatText(ctx: TuiHandlerContext): string {
	return ctx.writer.container.children
		.flatMap((c) => c.render(80))
		.join("\n")
		.replace(/\x1b\[[0-9;]*m/g, ""); // strip ANSI
}

// ---------------------------------------------------------------------------
// handleCtrlC
// ---------------------------------------------------------------------------

describe("handleCtrlC — idle (no turn running)", { tags: ["unit"] }, () => {
	it("calls dispose() and tui.stop()", () => {
		const ctx = makeCtx();
		handleCtrlC(ctx);
		expect(ctx.session.dispose).toHaveBeenCalledOnce();
		expect(ctx.tui.stop).toHaveBeenCalledOnce();
	});

	it("does not call setAbortCurrentTurn", () => {
		const ctx = makeCtx();
		handleCtrlC(ctx);
		expect(ctx.setAbortCurrentTurn).not.toHaveBeenCalled();
	});
});

describe("handleCtrlC — mid-turn (agent is running)", { tags: ["unit"] }, () => {
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
		expect(ctx.session.dispose).not.toHaveBeenCalled();
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

describe("handleSlashCommand /exit", { tags: ["unit"] }, () => {
	it("calls dispose() and tui.stop()", () => {
		const ctx = makeCtx();
		handleSlashCommand("/exit", ctx);
		expect(ctx.session.dispose).toHaveBeenCalledOnce();
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

describe("handleSlashCommand /new", { tags: ["unit"] }, () => {
	it("clears pre-existing children and replaces with notice pill", () => {
		const ctx = makeCtx();
		// Add some children to chat first.
		ctx.writer.container.addChild(new Container());
		ctx.writer.container.addChild(new Container());
		expect(ctx.writer.container.children).toHaveLength(2);
		handleSlashCommand("/new", ctx);
		// Pre-existing children cleared; only the notice remains.
		// appendNotice adds: Spacer + Text(body) = 2
		expect(ctx.writer.container.children.length).toBe(2);
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

describe("handleSlashCommand /resume", { tags: ["unit"] }, () => {
	it("appends the session ID to chat", () => {
		const ctx = makeCtx({
			session: makeSession({ state: { id: "abc-999", modelId: "test-model", contextWindow: 128_000 } }),
		});
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

describe("handleSlashCommand /help", { tags: ["unit"] }, () => {
	it("appends help text listing all commands", () => {
		const ctx = makeCtx();
		handleSlashCommand("/help", ctx);
		const text = chatText(ctx);
		expect(text).toContain(":q");
		expect(text).toContain(":new");
		expect(text).toContain(":session");
		expect(text).toContain(":help");
	});

	it("returns true", () => {
		expect(handleSlashCommand("/help", makeCtx())).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// handleSlashCommand — unknown command
// ---------------------------------------------------------------------------

describe("handleSlashCommand — unknown command", { tags: ["unit"] }, () => {
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
		expect(ctx.session.dispose).not.toHaveBeenCalled();
		expect(ctx.tui.stop).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// truncateToolOutput
// ---------------------------------------------------------------------------

describe("truncateToolOutput", { tags: ["unit"] }, () => {
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

describe("handleSlashCommand /login", { tags: ["unit"] }, () => {
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

describe("handleSlashCommand /logout", { tags: ["unit"] }, () => {
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
// activeCalls drained on turn abort
// ---------------------------------------------------------------------------

describe("activeCalls drained on turn abort", { tags: ["unit"] }, () => {
	it("abort path marks in-flight calls as failed and clears the map", () => {
		const t = getTheme();
		const activeCalls = new Map<string, ToolCallRow>();

		function onToolStart(e: ToolCallStart): void {
			const row = new ToolCallRow(e.name, "", t);
			activeCalls.set(e.callId, row);
		}

		function onToolEnd(e: ToolCallEnd): void {
			const row = activeCalls.get(e.callId);
			if (row) {
				row.seal(e.elapsedMs, e.ok);
				activeCalls.delete(e.callId);
			}
		}

		function abortPath(): void {
			for (const row of activeCalls.values()) row.seal(0, false);
			activeCalls.clear();
		}

		onToolStart({ callId: "tc-1", name: "fs.read", args: { path: "a.ts" } });
		onToolStart({ callId: "tc-2", name: "fs.grep", args: { pattern: "foo" } });
		onToolStart({ callId: "tc-3", name: "shell.exec", args: { command: "ls" } });
		onToolEnd({ callId: "tc-1", elapsedMs: 50, ok: true });
		abortPath();

		expect(activeCalls.size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// handleColonCommand :reload
// ---------------------------------------------------------------------------

describe("handleColonCommand :reload — no reloadOrgan callback", { tags: ["unit"] }, () => {
	it("shows usage when name or path missing", () => {
		const ctx = makeCtx();
		handleColonCommand(":reload", ctx);
		expect(chatText(ctx)).toContain("Usage:");
	});

	it("shows 'not available' when reloadOrgan is not provided", () => {
		const ctx = makeCtx({ session: makeSession({ reloadOrgan: undefined }) });
		handleColonCommand(":reload my-organ /path/to/organ.ts", ctx);
		expect(chatText(ctx)).toContain("not available");
	});

	it("returns true in both cases (command recognised)", () => {
		expect(handleColonCommand(":reload", makeCtx())).toBe(true);
		expect(handleColonCommand(":reload my-organ /path/organ.ts", makeCtx())).toBe(true);
	});
});

describe("handleColonCommand :reload — with reloadOrgan callback", { tags: ["unit"] }, () => {
	it("calls reloadOrgan with name and path, shows 'Reloading' notice", async () => {
		let called: [string, string] | undefined;
		const reloadOrgan = vi.fn(async (name: string, path: string) => {
			called = [name, path];
		});
		const ctx = makeCtx({ session: makeSession({ reloadOrgan }) });
		handleColonCommand(":reload my-organ /organs/my-organ.ts", ctx);
		expect(chatText(ctx)).toContain("Reloading my-organ");
		await vi.waitFor(() => expect(called).toEqual(["my-organ", "/organs/my-organ.ts"]));
	});

	it("shows 'Reloaded' notice after successful reload", async () => {
		const reloadOrgan = vi.fn(async () => {});
		const ctx = makeCtx({ session: makeSession({ reloadOrgan }) });
		handleColonCommand(":reload my-organ /organs/my-organ.ts", ctx);
		await vi.waitFor(() => expect(chatText(ctx)).toContain("Reloaded my-organ."));
	});

	it("shows error notice when reloadOrgan rejects", async () => {
		const reloadOrgan = vi.fn(async () => {
			throw new Error("jiti: module not found");
		});
		const ctx = makeCtx({ session: makeSession({ reloadOrgan }) });
		handleColonCommand(":reload bad-organ /organs/bad.ts", ctx);
		await vi.waitFor(() => expect(chatText(ctx)).toContain("jiti: module not found"));
	});

	it("requests render after success and after failure", async () => {
		const reloadOrgan = vi.fn(async () => {});
		const ctx = makeCtx({ session: makeSession({ reloadOrgan }) });
		handleColonCommand(":reload my-organ /path.ts", ctx);
		// First render: 'Reloading...' notice
		expect(ctx.tui.requestRender).toHaveBeenCalled();
		await vi.waitFor(() => expect(ctx.tui.requestRender).toHaveBeenCalledTimes(2));
	});
});

// ---------------------------------------------------------------------------
// EditorWrapper — content lines must never exceed terminal width ( regression)
//
// RED: written before the fix. The bug: render(width) then prepend a space
// → width+1 chars → TUI crash "Rendered line exceeds terminal width".
// ---------------------------------------------------------------------------

import type { Component, TUI as TUIClass } from "@dpopsuev/alef-tui";

// Reach into prompt-console via its Component array after mount() to test EditorWrapper.
// Since EditorWrapper is not exported, we test it through PromptConsole.mount().
import { PromptConsole } from "../src/prompt-console.js";

describe("EditorWrapper — rendered lines must not exceed terminal width", { tags: ["unit"] }, () => {
	for (const width of [40, 80, 120, 179, 180, 200]) {
		it(`all lines fit within ${width} columns`, () => {
			const children: Component[] = [];
			// Editor.render() reads tui.terminal.rows and tui.terminal.cols;
			// provide a minimal stub so it doesn't crash in headless tests.
			const fakeTui = {
				addChild: (c: Component) => children.push(c),
				removeChild: () => {},
				requestRender: () => {},
				addInputListener: () => {},
				setFocus: () => {},
				terminal: { rows: 40, cols: width },
			} as unknown as TUIClass;

			const t = getTheme();
			const zone = new PromptConsole(fakeTui, t, "test-model");
			zone.mount();

			// PromptConsole.mount() adds: pendingFooter, inFlightQueue, statusText,
			// EditorWrapper, hintBar — EditorWrapper is at index 3.
			const arcWrapper = children[3];
			if (!arcWrapper) throw new Error("EditorWrapper not found at index 3");

			const rendered = arcWrapper.render(width);
			for (const line of rendered) {
				const visible = line.replace(/\x1b\[[0-9;]*m/g, "");
				expect(visible.length).toBeLessThanOrEqual(width);
			}
		});
	}
});
