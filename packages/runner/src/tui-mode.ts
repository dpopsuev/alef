/**
 * TUI interactive mode.
 *
 * Three Bauhaus zones:
 *   Identity:     ▪ ALEF  ─  model  ─  session
 *                 ──────────────────────────────  (rule)
 *   Conversation: turns, tool events, agent replies
 *                 ──────────────────────────────  (rule)
 *   Action:       /exit · /new · /help        ⬡ 5s
 *                 ▸ input
 */

import type { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import type { Component, MarkdownTheme } from "@dpopsuev/alef-tui";
import { Container, Input, Loader, Markdown, ProcessTerminal, Spacer, Text, TUI } from "@dpopsuev/alef-tui";
import { trace } from "./debug-trace.js";
import { formatError } from "./errors.js";
import type { InteractiveOptions } from "./interactive.js";
import { bold, boldColor, color, DIM, dim, getTheme, glyph, RESET, spinnerFrames } from "./theme.js";

// ---------------------------------------------------------------------------
// Dynamic component — renders by calling a function at render time.
// Used for horizontal rules (width-aware) and the hint/status bar.
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
// Handler context — testable via direct construction with mock collaborators.
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
// Markdown theme
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

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

function horizontalRule(): DynamicText {
	const t = getTheme();
	return new DynamicText((w) => color(glyph("sep").repeat(Math.max(1, w - 2)), t.dimFg));
}

function appendUserMsg(chat: Container, text: string): void {
	const t = getTheme();
	chat.addChild(new Text(`${DIM}${color(glyph("user"), t.accentFg)} ${RESET}${text}`, 1, 0));
}

function appendAgentMsg(chat: Container, text: string): void {
	chat.addChild(new Spacer(1));
	try {
		chat.addChild(new Markdown(text, 1, 0, makeMarkdownTheme()));
	} catch {
		chat.addChild(new Text(text, 1, 0));
	}
	chat.addChild(new Spacer(1));
}

function appendNotice(chat: Container, text: string): void {
	const t = getTheme();
	chat.addChild(new Text(`${color(glyph("sep"), t.dimFg)} ${dim(text)}`, 1, 0));
}

/** Render a tool call line in active state (no elapsed yet). */
function toolActiveLine(name: string, keyArg: string): string {
	const t = getTheme();
	return `  ${color(glyph("state:active"), t.warnFg)} ${color(name, t.toolNameFg)}  ${color(keyArg, t.toolArgFg)}`;
}

/** Render a tool call line in done/error state. */
export function renderToolLine(name: string, keyArg: string, elapsedMs: number, ok: boolean): string {
	const t = getTheme();
	const elapsed = elapsedMs >= 1000 ? `${(elapsedMs / 1000).toFixed(1)}s` : `${elapsedMs}ms`;
	const statusGlyph = ok ? glyph("state:done") : glyph("state:error");
	const statusColor = ok ? t.toolOkFg : t.toolErrFg;
	return `  ${color(statusGlyph, statusColor)} ${color(name, t.toolNameFg)}  ${color(keyArg, t.toolArgFg)}  ${color(elapsed, t.timeFg)}`;
}

function keyArgFromPayload(args: Record<string, unknown>): string {
	for (const key of ["command", "path", "url", "pattern", "glob", "symbol", "query"]) {
		const v = args[key];
		if (typeof v === "string" && v.length > 0) return v.slice(0, 60);
	}
	return "";
}

const COMMANDS: Record<string, string> = {
	"/exit": "Quit Alef",
	"/new": "Clear conversation history",
	"/resume": "Show current session ID",
	"/help": "Show this help",
};

function helpText(): string {
	return Object.entries(COMMANDS)
		.map(([cmd, desc]) => `  ${cmd.padEnd(12)} ${desc}`)
		.join("\n");
}

// ---------------------------------------------------------------------------
// TUI mode entry point
// ---------------------------------------------------------------------------

export interface TuiToolSlot {
	onToolStart: ((callId: string, name: string, args: Record<string, unknown>) => void) | undefined;
	onToolEnd: ((callId: string, elapsedMs: number, ok: boolean) => void) | undefined;
}

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

	// ── Identity zone ─────────────────────────────────────────────────────────
	const sessionShort = opts.sessionId.slice(0, 8);
	const header = `${boldColor(`${glyph("bullet")} ALEF`, t.accentFg)}  ${color(glyph("sep"), t.dimFg)}  ${color(opts.modelId, t.modelFg)}  ${color(glyph("sep"), t.dimFg)}  ${color(sessionShort, t.dimFg)}`;
	tui.addChild(new Text(header, 1, 0));
	tui.addChild(horizontalRule());

	// ── Conversation zone ──────────────────────────────────────────────────────
	const chat = new Container();
	tui.addChild(chat);

	// ── Loader ────────────────────────────────────────────────────────────────
	const loader = new Loader(
		tui,
		(s) => color(s, t.warnFg),
		(s) => color(s, t.dimFg),
		"Thinking…",
		{ frames: spinnerFrames(12), intervalMs: 180 },
	);

	// ── Action zone ────────────────────────────────────────────────────────────
	// Zone rule + dynamic hint/status bar on one line + input
	tui.addChild(horizontalRule());

	// Thinking elapsed timer — updated while loader is visible
	let thinkingStart = 0;
	let thinkingTimer: NodeJS.Timeout | undefined;
	let thinkingText = "";

	const hintBar = new DynamicText((w) => {
		const hints = dim(["/exit", "/new", "/resume", "/help"].join(` ${color(glyph("dot"), t.dimFg)} `));
		const status = thinkingText ? `${color(glyph("state:active"), t.warnFg)} ${color(thinkingText, t.dimFg)}` : "";
		if (!status) return hints;
		// Right-align status
		const hintsPlain = "/exit · /new · /resume · /help";
		const gap = Math.max(1, w - hintsPlain.length - status.replace(/\x1b\[[0-9;]*m/g, "").length - 2);
		return `${hints}${" ".repeat(gap)}${status}`;
	});
	tui.addChild(hintBar);

	const input = new Input();
	tui.addChild(input);

	// ── Tool call live tracking ────────────────────────────────────────────────
	// Maps callId → { textComponent, name, keyArg }
	const activeCalls = new Map<string, { text: Text; name: string; keyArg: string }>();

	// Fill the tool slot synchronously — these handlers are ready before any turn starts.
	if (toolSlot) {
		toolSlot.onToolStart = (callId, name, args) => {
			const keyArg = keyArgFromPayload(args);
			const textComponent = new Text(toolActiveLine(name, keyArg), 1, 0);
			activeCalls.set(callId, { text: textComponent, name, keyArg });
			chat.addChild(textComponent);
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
	}

	// ── Ctrl+C handler ─────────────────────────────────────────────────────────
	let abortCurrentTurn: (() => void) | undefined;

	const ctx = (): TuiHandlerContext => ({
		chat,
		tui,
		hintBar,
		loader,
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
		if (data === "\x03") {
			trace("raw:x03");
			handleCtrlC(ctx());
			return true;
		}
		return false;
	};

	// ── Submit handler ─────────────────────────────────────────────────────────
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

		tui.removeChild(hintBar);
		tui.removeChild(input);
		tui.addChild(loader);
		tui.requestRender(true);

		// Start elapsed timer for status bar
		thinkingStart = Date.now();
		thinkingText = "0s";
		thinkingTimer = setInterval(() => {
			thinkingText = `${Math.floor((Date.now() - thinkingStart) / 1000)}s`;
			tui.requestRender();
		}, 1000);

		let aborted = false;
		const controller = new AbortController();
		setLLMAbortController(controller);
		abortCurrentTurn = () => {
			aborted = true;
			controller.abort();
		};

		try {
			const reply = await dialog.send(text, "human", 300_000);
			if (!aborted) appendAgentMsg(chat, reply);
		} catch (e) {
			if (!aborted) appendNotice(chat, `[error] ${formatError(e)}`);
		} finally {
			abortCurrentTurn = undefined;
			setLLMAbortController(undefined);
			clearInterval(thinkingTimer);
			thinkingTimer = undefined;
			thinkingText = "";
			tui.removeChild(loader);
			tui.addChild(hintBar);
			tui.addChild(input);
			tui.requestRender(true);
		}
	};

	// ── Start ──────────────────────────────────────────────────────────────────
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

	if (thinkingTimer) clearInterval(thinkingTimer);
	trace("tui:stopped");
}
