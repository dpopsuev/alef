/**
 * TUI command handler unit tests — no PTY, no real terminal, no process spawning.
 *
 * Pattern mirrors pi-mono's interactive-mode-*.test.ts:
 * Call the exported handler functions with a fake context object.
 * Assert on what the handlers called on the collaborators.
 *
 * Covers:
 * handleCtrlC — idle (quit) and mid-turn (cancel) paths
 */

import type { ToolCallEnd, ToolCallStart } from "@dpopsuev/alef-reasoner/tool-events";
import type { Session } from "@dpopsuev/alef-session/contracts";
import { Container } from "@dpopsuev/alef-tui";
import { ChatLog, ToolCallRow } from "@dpopsuev/alef-tui/views";
import { describe, expect, it, vi } from "vitest";
import type { TuiHandlerContext } from "../src/client/runner.js";
import { handleColonCommand, handleCtrlC, truncateToolOutput } from "../src/client/runner.js";
import { getTheme } from "../src/client/theme.js";

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
		loadAdapter: vi.fn(),
		unloadAdapter: vi.fn(() => true),
		reloadAdapter: vi.fn(),
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
		dispatch: vi.fn(),
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

describe("handleColonCommand :reload — no reloadAdapter callback", { tags: ["unit"] }, () => {
	it("shows usage when name or path missing", () => {
		const ctx = makeCtx();
		handleColonCommand(":reload", ctx);
		expect(chatText(ctx)).toContain("Usage:");
	});

	it("shows 'not available' when reloadAdapter is not provided", () => {
		const ctx = makeCtx({ session: makeSession({ reloadAdapter: undefined }) });
		handleColonCommand(":reload my-adapter /path/to/adapter.ts", ctx);
		expect(chatText(ctx)).toContain("not available");
	});

	it("returns true in both cases (command recognised)", () => {
		expect(handleColonCommand(":reload", makeCtx())).toBe(true);
		expect(handleColonCommand(":reload my-adapter /path/adapter.ts", makeCtx())).toBe(true);
	});
});

describe("handleColonCommand :reload — with reloadAdapter callback", { tags: ["unit"] }, () => {
	it("calls reloadAdapter with name and path, shows 'Reloading' notice", async () => {
		let called: [string, string] | undefined;
		const reloadAdapter = vi.fn(async (name: string, path: string) => {
			called = [name, path];
		});
		const ctx = makeCtx({ session: makeSession({ reloadAdapter }) });
		handleColonCommand(":reload my-adapter /adapters/my-adapter.ts", ctx);
		expect(chatText(ctx)).toContain("Reloading my-adapter");
		await vi.waitFor(() => expect(called).toEqual(["my-adapter", "/adapters/my-adapter.ts"]));
	});

	it("shows 'Reloaded' notice after successful reload", async () => {
		const reloadAdapter = vi.fn(async () => {});
		const ctx = makeCtx({ session: makeSession({ reloadAdapter }) });
		handleColonCommand(":reload my-adapter /adapters/my-adapter.ts", ctx);
		await vi.waitFor(() => expect(chatText(ctx)).toContain("Reloaded my-adapter."));
	});

	it("shows error notice when reloadAdapter rejects", async () => {
		const reloadAdapter = vi.fn(async () => {
			throw new Error("jiti: module not found");
		});
		const ctx = makeCtx({ session: makeSession({ reloadAdapter }) });
		handleColonCommand(":reload bad-adapter /adapters/bad.ts", ctx);
		await vi.waitFor(() => expect(chatText(ctx)).toContain("jiti: module not found"));
	});

	it("requests render after success and after failure", async () => {
		const reloadAdapter = vi.fn(async () => {});
		const ctx = makeCtx({ session: makeSession({ reloadAdapter }) });
		handleColonCommand(":reload my-adapter /path.ts", ctx);
		// First render: 'Reloading...' notice
		expect(ctx.tui.requestRender).toHaveBeenCalled();
		await vi.waitFor(() => expect(ctx.tui.requestRender).toHaveBeenCalledTimes(2));
	});
});

// ---------------------------------------------------------------------------
// EditorChrome — content lines must never exceed terminal width ( regression)
//
// RED: written before the fix. The bug: render(width) then prepend a space
// → width+1 chars → TUI crash "Rendered line exceeds terminal width".
// ---------------------------------------------------------------------------

import type { Component, TUI as TUIClass } from "@dpopsuev/alef-tui";

// Reach into prompt-console via its Component array after mount() to test EditorChrome.
// Since EditorChrome is not exported, we test it through DockConsole.mount().
import { DockConsole } from "../src/client/console.js";

describe("EditorChrome — rendered lines must not exceed terminal width", { tags: ["unit"] }, () => {
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
				setDock: () => {},
				terminal: { rows: 40, cols: width },
			} as unknown as TUIClass;

			const t = getTheme();
			const zone = new DockConsole(fakeTui, t, "test-model");
			zone.mount();

			const arcWrapper = children.find((child) => child.render(width).length > 1);
			if (!arcWrapper) throw new Error("EditorChrome not found");

			const rendered = arcWrapper.render(width);
			for (const line of rendered) {
				const visible = line.replace(/\x1b\[[0-9;]*m/g, "");
				expect(visible.length).toBeLessThanOrEqual(width);
			}
		});
	}

	it("renders the mode label on the left with a trailing separator", () => {
		const width = 40;
		const children: Component[] = [];
		const fakeTui = {
			addChild: (c: Component) => children.push(c),
			removeChild: () => {},
			requestRender: () => {},
			addInputListener: () => {},
			setFocus: () => {},
			setDock: () => {},
			terminal: { rows: 40, cols: width },
		} as unknown as TUIClass;

		const t = getTheme();
		const zone = new DockConsole(fakeTui, t, "test-model");
		zone.mount();
		zone.setStatus("INSERT");

		const wrapper = children.find((child) => child.render(width).some((line) => line.includes("INSERT")));
		if (!wrapper) throw new Error("EditorChrome with mode label not found");

		const visible = wrapper
			.render(width)
			.at(-1)!
			.replace(/\x1b\[[0-9;]*m/g, "");
		expect(visible.startsWith("─ INSERT ")).toBe(true);
		expect(visible.endsWith("─")).toBe(true);
	});
});
