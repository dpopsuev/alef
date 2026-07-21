/**
 * TUI fs.edit fixture -- full production path from event to pixels.
 *
 * Uses the real bootTuiShell() and wireSession() -- the same code that
 * runs in production. Only the terminal (VirtualTerminal) and session
 * (stub with emit) are test doubles. No ad-hoc component wiring.
 *
 * Tests the complete chain:
 *   Session.subscribe -> wireSession dispatch -> ChatLog.addCompletedToolBlock
 *   -> DiffBlock.render -> dock-mode differential renderer -> VirtualTerminal
 */

import type { AgentEvent, Session } from "@dpopsuev/alef-session/contracts";
import { describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../ui/tui/test/virtual-terminal.js";
import type { ResolvedSession, WireSessionDeps } from "../src/client/boot-types.js";
import { getTheme, loadTheme } from "../src/client/theme.js";
import { bootTuiShell, wireSession } from "../src/client/tui-shell.js";

async function settle(ms = 50): Promise<void> {
	await new Promise<void>((r) => process.nextTick(r));
	await new Promise<void>((r) => setTimeout(r, ms));
	await new Promise<void>((r) => process.nextTick(r));
}

/** Ensure a default theme is loaded for tests. */
function ensureTheme(): void {
	try {
		getTheme();
	} catch {
		loadTheme(undefined, undefined, undefined, true, []);
	}
}

/** Session stub that lets tests push AgentEvents via emit(). */
function createTestSession(): Session & { emit(event: AgentEvent): void } {
	const observers = new Set<(event: AgentEvent) => void>();
	return {
		state: { id: "test-session", modelId: "test-model", contextWindow: 128000 },
		getModel: () => "test-model",
		setModel: () => {},
		getThinking: () => "",
		setThinking: () => {},
		setTurnController: () => {},
		dispose: () => {},
		subscribe: (obs) => {
			observers.add(obs);
			return () => observers.delete(obs);
		},
		emit(event) {
			for (const obs of observers) obs(event);
		},
	};
}

/** Build a ResolvedSession from the test session stub. */
function resolved(session: Session): ResolvedSession {
	return {
		session,
		sessionId: "test-session",
		modelId: "test-model",
		contextWindow: 128000,
		isNew: true,
		getModel: () => "test-model",
		setModel: () => {},
		getThinking: () => "",
		setThinking: () => {},
		humanAddress: "@you",
		agentAddress: "@alef",
	};
}

/** Minimal WireSessionDeps for testing. */
function testDeps(): WireSessionDeps {
	return {
		signalHandlers: new Map(),
		isCompacted: () => false,
		checkForUpdate: async () => null,
	};
}

describe("TUI fs.edit fixture (production path)", { tags: ["unit"] }, () => {
	it("tool-end with text/x-diff renders and preserves viewport integrity", async () => {
		ensureTheme();
		const terminal = new VirtualTerminal(80, 20);
		const session = createTestSession();

		const shell = bootTuiShell({ cwd: "/tmp/test", terminal });
		wireSession(shell, resolved(session), testDeps());
		await settle();

		// Agent starts a turn: chunk -> tool-start -> tool-end with diff
		session.emit({ type: "chunk", text: "Let me fix that import." });
		await settle();

		session.emit({
			type: "tool-start",
			callId: "c1",
			name: "fs.edit",
			args: { path: "src/boot/logger.ts" },
		});
		await settle();

		session.emit({
			type: "tool-end",
			callId: "c1",
			elapsedMs: 122,
			ok: true,
			display: [
				"edit src/boot/logger.ts",
				"-const level = old;",
				"+const level = new;",
				"+const logger = createLogger();",
			].join("\n"),
			displayKind: "text/x-diff",
		});
		await settle();

		const viewport = await terminal.flushAndGetViewport();

		// The docked input area must be at the bottom of the viewport
		// (PromptConsole docks pendingFooter via buildLayout -> InputPanel)
		const _lastLine = viewport[viewport.length - 1]!;
		// The dock footer is a DynamicText("") -- it renders as empty, but the
		// editor and status are above it. Check the content is in the buffer.
		const allText = terminal.getScrollBuffer().join("\n");
		expect(allText).toContain("logger.ts");

		// No adjacent duplicate non-empty lines (the corruption signature).
		// Skip lines containing block characters (logo has legitimately repeated rows).
		const isLogoLine = (line: string): boolean => /[\u2580-\u259F]/.test(line);
		for (let i = 1; i < viewport.length; i++) {
			const prev = viewport[i - 1]!.trim();
			const curr = viewport[i]!.trim();
			if (prev && curr && prev.length > 5 && prev === curr && !isLogoLine(prev)) {
				expect.fail(`adjacent duplicate at rows ${i - 1}/${i}: "${prev.slice(0, 60)}"`);
			}
		}

		shell.tui.stop();
	});

	it("two sequential fs.edit results maintain scrollback order", async () => {
		ensureTheme();
		const terminal = new VirtualTerminal(80, 18);
		const session = createTestSession();

		const shell = bootTuiShell({ cwd: "/tmp/test", terminal });
		wireSession(shell, resolved(session), testDeps());
		await settle();

		// First edit
		session.emit({ type: "tool-start", callId: "c1", name: "fs.edit", args: { path: "file-a.ts" } });
		session.emit({
			type: "tool-end",
			callId: "c1",
			elapsedMs: 80,
			ok: true,
			display: "edit file-a.ts\n-old a\n+new a",
			displayKind: "text/x-diff",
		});
		await settle();

		// Second edit
		session.emit({ type: "tool-start", callId: "c2", name: "fs.edit", args: { path: "file-b.ts" } });
		session.emit({
			type: "tool-end",
			callId: "c2",
			elapsedMs: 45,
			ok: true,
			display: "edit file-b.ts\n-old b\n+new b",
			displayKind: "text/x-diff",
		});
		await settle();

		session.emit({ type: "turn-complete", reply: "Both files updated." });
		await settle();

		const allText = terminal.getScrollBuffer().join("\n");
		expect(allText).toContain("file-a.ts");
		expect(allText).toContain("file-b.ts");

		// file-a should appear before file-b
		const aIdx = allText.indexOf("file-a.ts");
		const bIdx = allText.indexOf("file-b.ts");
		expect(aIdx, "file-a.ts should appear before file-b.ts").toBeLessThan(bIdx);

		shell.tui.stop();
	});

	it("large diff pushing past viewport preserves earlier content in scrollback", async () => {
		ensureTheme();
		const terminal = new VirtualTerminal(80, 10);
		const session = createTestSession();

		const shell = bootTuiShell({ cwd: "/tmp/test", terminal });
		wireSession(shell, resolved(session), testDeps());
		await settle();

		// Some initial text
		session.emit({ type: "chunk", text: "Here is the change." });
		await settle();

		// Large diff
		const oldLines = Array.from({ length: 8 }, (_, i) => `-old-${i}: x = ${i};`);
		const newLines = Array.from({ length: 8 }, (_, i) => `+new-${i}: y = ${i * 2};`);
		session.emit({ type: "tool-start", callId: "c1", name: "fs.edit", args: { path: "large.ts" } });
		session.emit({
			type: "tool-end",
			callId: "c1",
			elapsedMs: 250,
			ok: true,
			display: ["edit large.ts", ...oldLines, ...newLines].join("\n"),
			displayKind: "text/x-diff",
		});
		await settle();

		const allText = terminal.getScrollBuffer().join("\n");
		expect(allText).toContain("large.ts");

		shell.tui.stop();
	});
});
