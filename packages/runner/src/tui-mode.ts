/**
 * TUI layout — StreamZone + ConsoleZone.
 *
 *   StreamZone (terminal owns):
 *     splash   — Braille glyph art, printed once
 *     header   — identity line, printed once
 *     ───────────────────────────────────────────
 *     chat     — append-only, grows into scrollback
 *
 *   ConsoleZone (we own — always visible, fixed height):
 *     ───────────────────────────────────────────
 *     status   — "" | "⬡ Thinking… 3s" | "─ (interrupted)"
 *     hint     — keybindings
 *     input    — editor, always present
 *
 * No addChild/removeChild after startup. Content changes, structure doesn't.
 * Terminal scrollback handles history — we never manage viewport.
 */

import type { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import type { Component, MarkdownTheme } from "@dpopsuev/alef-tui";
import { Container, Input, Markdown, matchesKey, ProcessTerminal, Spacer, Text, TUI } from "@dpopsuev/alef-tui";
import { getConfig } from "./config.js";
import { trace } from "./debug-trace.js";
import { formatError } from "./errors.js";
import type { InteractiveOptions } from "./interactive.js";
import { renderSplash } from "./splash.js";
import { bold, boldColor, color, dim, getTheme, glyph, RESET, spinnerFrames } from "./theme.js";

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

const YOU_LABEL = process.env.ALEF_YOU_LABEL ?? getConfig().you ?? "@you";
const AGENT_LABEL = process.env.ALEF_AGENT_LABEL ?? getConfig().agent ?? "@alef";

function _zoneClose(): DynamicText {
	const t = getTheme();
	return new DynamicText((w) => color(`╰${"─".repeat(Math.max(0, w - 2))}╯`, t.dimFg));
}

function zoneOpen(): DynamicText {
	const t = getTheme();
	return new DynamicText((w) => color(`╭${"─".repeat(Math.max(0, w - 2))}╮`, t.dimFg));
}

function pillHeaderStr(label: string, width: number): string {
	const inner = `─ ${label} `;
	const fill = Math.max(0, width - inner.length - 3);
	return `╭${inner}${"─".repeat(fill)}╮`;
}

function pillFooterStr(width: number): string {
	return `╰${"─".repeat(Math.max(0, width - 2))}╯`;
}

function appendPillBlock(
	chat: Container,
	label: string,
	colorFn: (s: string) => string,
	body: () => void,
	tokenSlot?: { text: Text | null },
): void {
	chat.addChild(new Spacer(1));
	chat.addChild(new DynamicText((w) => colorFn(pillHeaderStr(label, w))));
	body();
	if (tokenSlot !== undefined) {
		const tf = new Text("", 1, 0);
		chat.addChild(tf);
		tokenSlot.text = tf;
	}
	chat.addChild(new DynamicText((w) => colorFn(pillFooterStr(w))));
	chat.addChild(new Spacer(1));
}

function appendUserMsg(chat: Container, text: string): void {
	const t = getTheme();
	appendPillBlock(
		chat,
		YOU_LABEL,
		(s) => color(s, t.accentFg),
		() => {
			chat.addChild(new Text(text, 2, 0));
		},
	);
}

function appendAgentMsg(chat: Container, text: string, tokenSlot?: { text: Text | null }): void {
	const t = getTheme();
	appendPillBlock(
		chat,
		AGENT_LABEL,
		(s) => color(s, t.modelFg),
		() => {
			try {
				chat.addChild(new Markdown(text, 2, 0, makeMarkdownTheme()));
			} catch {
				chat.addChild(new Text(text, 2, 0));
			}
		},
		tokenSlot,
	);
}

function appendNotice(chat: Container, text: string): void {
	const t = getTheme();
	appendPillBlock(
		chat,
		"─",
		(s) => dim(color(s, t.dimFg)),
		() => {
			chat.addChild(new Text(dim(text), 2, 0));
		},
	);
}

function toolActiveLine(name: string, keyArg: string): string {
	const t = getTheme();
	const label = `${color(glyph("state:active"), t.warnFg)} ${color(name, t.toolNameFg)}`;
	const body = keyArg ? `  ${color(keyArg, t.toolArgFg)}` : "";
	return `  ${label}${body}`;
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
	onTextChunk: ((chunk: string) => void) | undefined;
	onThinkingChunk: ((chunk: string) => void) | undefined;
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

	// ── StreamZone (terminal owns) ────────────────────────────────────

	const sessionShort = opts.sessionId.slice(0, 8);
	const headerLabel = `${glyph("bullet")} ALEF  ${glyph("sep")}  ${sessionShort}`;
	// StreamZone: header pill wraps the splash glyph — same pattern as @you / @alef
	tui.addChild(
		new DynamicText((w) => {
			const inner = `─ ${headerLabel} `;
			return boldColor(`╭${inner}${"─".repeat(Math.max(0, w - inner.length - 3))}╮`, t.accentFg);
		}),
	);
	const splash = await renderSplash();
	if (splash) tui.addChild(new Text(splash, 2, 0));
	tui.addChild(new DynamicText((w) => boldColor(`╰${"─".repeat(Math.max(0, w - 2))}╯`, t.accentFg)));

	const chat = new Container();
	tui.addChild(chat);

	// ── ConsoleZone (we own) ─────────────────────────────────────────────────

	// Spinner sits ABOVE the zone delimiter so it's always the first thing visible.
	const statusText = new Text("", 0, 0);
	tui.addChild(statusText);

	tui.addChild(zoneOpen());

	const input = new Input();
	tui.addChild(input);

	const hintBar = new DynamicText((_w) => dim("/exit · /new · /resume · /help"));
	tui.addChild(hintBar);

	tui.addChild(new Text(dim(opts.modelId), 0, 0));

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
		streamNode = null;
		streamBuf = "";
		thinkNode = null;
		thinkBuf = "";
	}

	// ── Live streaming state ─────────────────────────────────────────────

	let streamNode: Text | null = null;
	let streamBuf = "";
	let thinkNode: Text | null = null;
	let thinkBuf = "";

	function onTextChunk(chunk: string): void {
		if (!streamNode) {
			streamNode = new Text("", 2, 0);
			chat.addChild(streamNode);
		}
		streamBuf += chunk;
		streamNode.setText(streamBuf);
		tui.requestRender(true);
	}

	function onThinkingChunk(chunk: string): void {
		if (!thinkNode) {
			chat.addChild(new Text(dim("…thinking"), 2, 0));
			thinkNode = new Text("", 2, 0);
			chat.addChild(thinkNode);
		}
		thinkBuf += chunk;
		thinkNode.setText(dim(thinkBuf));
		tui.requestRender(true);
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
			const footer = dim(`${compact(tokenIn)} in · ${compact(tokenOut)} out`);
			if (pendingTokenFooter) {
				pendingTokenFooter.setText(footer);
				pendingTokenFooter = null;
				tui.requestRender(true);
			}
		};

		toolSlot.onTextChunk = (chunk) => onTextChunk(chunk);
		toolSlot.onThinkingChunk = (chunk) => onThinkingChunk(chunk);
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
