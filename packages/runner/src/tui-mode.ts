/**
 * TUI layout — two ownership zones:
 *
 *   Top (terminal owns scrolling):
 *     header   — printed once, lives in scrollback
 *     ───────────────────────────────────────────
 *     chat     — append-only, grows into scrollback
 *
 *   Bottom (we own — always visible, fixed height):
 *     ───────────────────────────────────────────
 *     status   — "" | "⬡ Thinking… 3s" | "─ (interrupted)"
 *     hint     — mode + keybindings
 *     input    — editor, always present
 *
 * No addChild/removeChild after startup. Content changes, structure doesn't.
 * Terminal scrollback handles history — we never manage viewport.
 */

import type { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import type { Component, MarkdownTheme } from "@dpopsuev/alef-tui";
import { Container, Input, Markdown, matchesKey, ProcessTerminal, Spacer, Text, TUI } from "@dpopsuev/alef-tui";
import { trace } from "./debug-trace.js";
import { formatError } from "./errors.js";
import type { InteractiveOptions } from "./interactive.js";
import { bold, boldColor, color, DIM, dim, getTheme, glyph, RESET, spinnerFrames } from "./theme.js";

// ---------------------------------------------------------------------------
// Dynamic component — renders by calling a function at render time.
// ---------------------------------------------------------------------------

class DynamicText implements Component {
	private fn: (width: number) => string;
	constructor(fn: (width: number) => string) {
		this.fn = fn;
	}
	render(width: number): string[] {
		return [this.fn(width)];
	}
	invalidate(): void {}
}

// ---------------------------------------------------------------------------
// Handler context
// ---------------------------------------------------------------------------

export interface TuiHandlerContext {
	chat: Container;
	tui: {
		stop(): void;
		removeChild(c: unknown): void;
		addChild(c: unknown): void;
		requestRender(force?: boolean): void;
	};
	hintBar: unknown;
	loader: unknown;
	dialog: { clearHistory(): void };
	dispose(): void;
	sessionId: string;
	abortCurrentTurn: (() => void) | undefined;
	setAbortCurrentTurn(fn: (() => void) | undefined): void;
	setLLMController(ctrl: AbortController | undefined): void;
}

export function handleCtrlC(ctx: TuiHandlerContext): void {
	if (ctx.abortCurrentTurn) {
		trace("ctrl+c:mid-turn");
		ctx.abortCurrentTurn();
		ctx.setAbortCurrentTurn(undefined);
		ctx.setLLMController(undefined);
		appendNotice(ctx.chat, "(interrupted)");
		ctx.tui.requestRender(true);
	} else {
		trace("ctrl+c:idle:dispose");
		ctx.dispose();
		trace("ctrl+c:idle:tui.stop");
		ctx.tui.stop();
		trace("ctrl+c:idle:done");
	}
}

export function handleSlashCommand(text: string, ctx: TuiHandlerContext): boolean {
	const cmd = text.split(" ")[0].toLowerCase();
	switch (cmd) {
		case "/exit":
			ctx.dispose();
			ctx.tui.stop();
			return true;
		case "/new":
			ctx.dialog.clearHistory();
			while (ctx.chat.children.length > 0) ctx.chat.removeChild(ctx.chat.children[0]);
			appendNotice(ctx.chat, "(conversation cleared)");
			ctx.tui.requestRender(true);
			return true;
		case "/resume":
			appendNotice(ctx.chat, `session: ${ctx.sessionId}`);
			ctx.tui.requestRender(true);
			return true;
		case "/help":
			appendNotice(ctx.chat, helpText());
			ctx.tui.requestRender(true);
			return true;
		default:
			appendNotice(ctx.chat, `Unknown command: ${cmd}. Type /help for list.`);
			ctx.tui.requestRender(true);
			return false;
	}
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function makeMarkdownTheme(): MarkdownTheme {
	const t = getTheme();
	return {
		heading: (s) => bold(s),
		link: (s) => color(s, t.toolNameFg),
		linkUrl: (s) => dim(s),
		code: (s) => color(s, t.accentFg),
		codeBlock: (s) => s,
		codeBlockBorder: (s) => dim(s),
		quote: (s) => dim(s),
		quoteBorder: (s) => dim(s),
		hr: (s) => dim(s),
		listBullet: (s) => color(s, t.accentFg),
		bold: (s) => bold(s),
		italic: (s) => `\x1b[3m${s}${RESET}`,
		strikethrough: (s) => s,
		underline: (s) => `\x1b[4m${s}${RESET}`,
	};
}

function horizontalRule(): DynamicText {
	const t = getTheme();
	return new DynamicText((w) => color(glyph("sep").repeat(Math.max(1, w - 2)), t.dimFg));
}

function appendUserMsg(chat: Container, text: string): void {
	const t = getTheme();
	chat.addChild(new Text(`${DIM}${color(glyph("user"), t.accentFg)} ${RESET}${text}`, 1, 0));
}

function appendAgentMsg(chat: Container, text: string, tokenSlot?: { text: Text | null }): void {
	chat.addChild(new Spacer(1));
	try {
		chat.addChild(new Markdown(text, 1, 0, makeMarkdownTheme()));
	} catch {
		chat.addChild(new Text(text, 1, 0));
	}
	if (tokenSlot !== undefined) {
		const footer = new Text("", 1, 0);
		chat.addChild(footer);
		tokenSlot.text = footer;
	}
	chat.addChild(new Spacer(1));
}

function appendNotice(chat: Container, text: string): void {
	const t = getTheme();
	chat.addChild(new Text(`${color(glyph("sep"), t.dimFg)} ${dim(text)}`, 1, 0));
}

function toolActiveLine(name: string, keyArg: string): string {
	const t = getTheme();
	return `  ${color(glyph("state:active"), t.warnFg)} ${color(name, t.toolNameFg)}  ${color(keyArg, t.toolArgFg)}`;
}

export function renderToolLine(name: string, keyArg: string, elapsedMs: number, ok: boolean): string {
	const t = getTheme();
	const elapsed = elapsedMs >= 1000 ? `${(elapsedMs / 1000).toFixed(1)}s` : `${elapsedMs}ms`;
	const g = ok ? glyph("state:done") : glyph("state:error");
	const fg = ok ? t.toolOkFg : t.toolErrFg;
	return `  ${color(g, fg)} ${color(name, t.toolNameFg)}  ${color(keyArg, t.toolArgFg)}  ${color(elapsed, t.timeFg)}`;
}

function keyArgFromPayload(args: Record<string, unknown>): string {
	for (const key of ["command", "path", "url", "pattern", "glob", "symbol", "query"]) {
		const v = args[key];
		if (typeof v === "string" && v.length > 0) return v.slice(0, 60);
	}
	return "";
}

function compact(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

const COMMANDS: Record<string, string> = {
	"/exit": "Quit",
	"/new": "Clear conversation",
	"/resume": "Show session ID",
	"/help": "Show this help",
};

function helpText(): string {
	return Object.entries(COMMANDS)
		.map(([cmd, desc]) => `  ${cmd.padEnd(12)} ${desc}`)
		.join("\n");
}

// ---------------------------------------------------------------------------
// Tool slot
// ---------------------------------------------------------------------------

export interface TuiToolSlot {
	onToolStart: ((callId: string, name: string, args: Record<string, unknown>) => void) | undefined;
	onToolEnd: ((callId: string, elapsedMs: number, ok: boolean) => void) | undefined;
	onTokenUsage: ((tokenIn: number, tokenOut: number) => void) | undefined;
}

// ---------------------------------------------------------------------------
// TUI mode
// ---------------------------------------------------------------------------

export async function runTuiMode(
	dialog: DialogOrgan,
	opts: InteractiveOptions & { sessionId: string },
	dispose: () => void,
	setLLMAbortController: (ctrl: AbortController | undefined) => void = () => {},
	toolSlot?: TuiToolSlot,
): Promise<void> {
	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal);
	const t = getTheme();

	// ── Top zone (terminal owns scrolling) ────────────────────────────────────

	const sessionShort = opts.sessionId.slice(0, 8);
	const header = `${boldColor(`${glyph("bullet")} ALEF`, t.accentFg)}  ${color(glyph("sep"), t.dimFg)}  ${color(opts.modelId, t.modelFg)}  ${color(glyph("sep"), t.dimFg)}  ${color(sessionShort, t.dimFg)}`;
	tui.addChild(new Text(header, 1, 0));
	tui.addChild(horizontalRule());

	const chat = new Container();
	tui.addChild(chat);

	// ── Bottom zone (we own) ──────────────────────────────────────────────────
	// Fixed structure — content changes, nothing is added or removed.

	tui.addChild(horizontalRule());

	// Status slot: empty when idle, animated when thinking, notice on interrupt.
	const statusText = new Text("", 0, 0);
	tui.addChild(statusText);

	// Hint bar: left = commands, right = active state (only when non-empty)
	const hintBar = new DynamicText((_w) => {
		const hints = dim(["/exit", "/new", "/resume", "/help"].join(` ${color(glyph("dot"), t.dimFg)} `));
		return hints;
	});
	tui.addChild(hintBar);

	const input = new Input();
	tui.addChild(input);

	// ── Spinner state ─────────────────────────────────────────────────────────

	const frames = spinnerFrames(12);
	let frameIdx = 0;
	let thinkingStart = 0;
	let thinkingTimer: NodeJS.Timeout | undefined;

	function startThinking(): void {
		thinkingStart = Date.now();
		frameIdx = 0;
		thinkingTimer = setInterval(() => {
			frameIdx = (frameIdx + 1) % frames.length;
			const elapsed = Math.floor((Date.now() - thinkingStart) / 1000);
			const frame = frames[frameIdx] ?? glyph("state:active");
			statusText.setText(`  ${color(frame, t.warnFg)} ${color(`${elapsed}s`, t.dimFg)}`);
			tui.requestRender();
		}, 180);
	}

	function stopThinking(): void {
		clearInterval(thinkingTimer);
		thinkingTimer = undefined;
		statusText.setText("");
	}

	// ── Tool call live tracking ───────────────────────────────────────────────

	const activeCalls = new Map<string, { text: Text; name: string; keyArg: string }>();
	let pendingTokenFooter: Text | null = null;

	if (toolSlot) {
		toolSlot.onToolStart = (callId, name, args) => {
			const keyArg = keyArgFromPayload(args);
			const line = new Text(toolActiveLine(name, keyArg), 1, 0);
			activeCalls.set(callId, { text: line, name, keyArg });
			chat.addChild(line);
			tui.requestRender(true);
		};
		toolSlot.onToolEnd = (callId, elapsedMs, ok) => {
			const entry = activeCalls.get(callId);
			if (entry) {
				entry.text.setText(renderToolLine(entry.name, entry.keyArg, elapsedMs, ok));
				activeCalls.delete(callId);
				tui.requestRender(true);
			}
		};
		toolSlot.onTokenUsage = (tokenIn, tokenOut) => {
			const footer = `${dim(`${compact(tokenIn)} in`)} ${color(glyph("dot"), t.dimFg)} ${dim(`${compact(tokenOut)} out`)}`;
			if (pendingTokenFooter) {
				pendingTokenFooter.setText(footer);
				pendingTokenFooter = null;
				tui.requestRender(true);
			}
		};
	}

	// ── Input / Ctrl+C ────────────────────────────────────────────────────────

	let abortCurrentTurn: (() => void) | undefined;

	const ctx = (): TuiHandlerContext => ({
		chat,
		tui,
		hintBar,
		loader: statusText,
		dialog,
		dispose,
		sessionId: opts.sessionId,
		abortCurrentTurn,
		setAbortCurrentTurn: (fn) => {
			abortCurrentTurn = fn;
		},
		setLLMController: (ctrl) => {
			setLLMAbortController(ctrl);
		},
	});

	tui.onRawInput = (data) => {
		if (matchesKey(data, "ctrl+c")) {
			trace("raw:ctrl+c", { seq: JSON.stringify(data) });
			handleCtrlC(ctx());
			return true;
		}
		return false;
	};

	// eslint-disable-next-line @typescript-eslint/no-misused-promises
	input.onSubmit = async (rawText: string) => {
		const text = rawText.trim();
		if (!text) return;
		if (text.startsWith("/")) {
			handleSlashCommand(text, ctx());
			return;
		}

		input.setValue("");
		appendUserMsg(chat, text);
		startThinking();
		tui.requestRender(true);

		let aborted = false;
		const controller = new AbortController();
		setLLMAbortController(controller);
		abortCurrentTurn = () => {
			aborted = true;
			controller.abort();
		};

		try {
			const reply = await dialog.send(text, "human", 300_000);
			if (!aborted) {
				stopThinking();
				const footerSlot = { text: null as Text | null };
				appendAgentMsg(chat, reply, footerSlot);
				pendingTokenFooter = footerSlot.text;
				tui.requestRender(true);
			}
		} catch (e) {
			stopThinking();
			if (!aborted) appendNotice(chat, `[error] ${formatError(e)}`);
			tui.requestRender(true);
		} finally {
			abortCurrentTurn = undefined;
			setLLMAbortController(undefined);
			if (thinkingTimer) stopThinking();
		}
	};

	// ── Start ─────────────────────────────────────────────────────────────────

	tui.start();
	tui.setFocus(input);
	tui.requestRender();
	trace("tui:start");

	await new Promise<void>((resolve) => {
		tui.onStop = () => {
			trace("tui:stop:resolve");
			resolve();
		};
	});

	if (thinkingTimer) stopThinking();
	trace("tui:stopped");
}
