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

import { getProviders } from "@dpopsuev/alef-ai";
import type { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import type { TokenUsage, ToolCallEnd, ToolCallStart } from "@dpopsuev/alef-organ-llm";
import {
	Box,
	Container,
	Markdown,
	type MarkdownTheme,
	matchesKey,
	ProcessTerminal,
	Spacer,
	Text,
	TUI,
} from "@dpopsuev/alef-tui";
import chalk from "chalk";
import { getStoredApiKey, removeStoredApiKey, setStoredApiKey } from "./auth.js";
import { getConfig } from "./config.js";
import { ConsoleZone } from "./console-zone.js";
import { trace } from "./debug-trace.js";
import { DynamicText } from "./dynamic-text.js";
import { formatError } from "./errors.js";
import type { InteractiveOptions } from "./interactive.js";
import { renderSplash } from "./splash.js";
import { bg, bold, boldColor, color, dim, getTheme, glyph, italic } from "./theme.js";
import { Typewriter } from "./typewriter.js";

export interface TuiHandlerContext {
	chat: Container;
	tui: {
		stop(): void;
		removeChild(c: unknown): void;
		addChild(c: unknown): void;
		requestRender(force?: boolean): void;
	};

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
			ctx.tui.requestRender();
			return true;
		case "/login": {
			const parts = text.trim().split(/\s+/);
			const provider = parts[1];
			const key = parts.slice(2).join(" ").trim();
			if (!provider || !key) {
				const known = getProviders().slice(0, 8).join(", ");
				appendNotice(ctx.chat, `Usage: /login <provider> <api-key>\nKnown providers: ${known}`);
			} else {
				setStoredApiKey(provider, key);
				appendNotice(ctx.chat, `Saved API key for ${provider}. Takes effect on the next message.`);
			}
			ctx.tui.requestRender();
			return true;
		}
		case "/logout": {
			const provider = text.trim().split(/\s+/)[1];
			if (!provider) {
				appendNotice(ctx.chat, "Usage: /logout <provider>");
			} else if (!getStoredApiKey(provider)) {
				appendNotice(ctx.chat, `No stored key for ${provider}.`);
			} else {
				removeStoredApiKey(provider);
				appendNotice(ctx.chat, `Removed stored key for ${provider}.`);
			}
			ctx.tui.requestRender();
			return true;
		}
		case "/help":
			appendNotice(ctx.chat, helpText());
			ctx.tui.requestRender();
			return true;
		default:
			appendNotice(ctx.chat, `Unknown command: ${cmd}. Type /help for list.`);
			ctx.tui.requestRender();
			return false;
	}
}

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
		italic: (s) => italic(s),
		strikethrough: (s) => s,
		underline: (s) => chalk.underline(s),
	};
}

const YOU_LABEL = process.env.ALEF_YOU_LABEL ?? getConfig().you ?? "@you";

export function pillHeaderStr(label: string, width: number): string {
	const inner = `─ ${label} `;
	const fill = Math.max(0, width - inner.length - 2);
	return `╭${inner}${"─".repeat(fill)}╮`;
}

export function pillFooterStr(width: number): string {
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
	// Label line above the block.
	chat.addChild(new Text(color(YOU_LABEL, t.userFg), 1, 0));
	// Full-width background block — Pi pattern: Box(bgFn=userMessageBg).
	const box = new Box(2, 0, (s) => bg(s, t.userBg));
	box.addChild(new Text(color(text, t.userFg), 0, 0));
	chat.addChild(box);
	chat.addChild(new Spacer(1));
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

/** Truncate tool output for inline display: max 20 lines, max 1000 chars. */
export function truncateToolOutput(text: string): string {
	const lines = text.split("\n");
	const capped = lines.length > 20 ? lines.slice(0, 20) : lines;
	let out = capped.join("\n");
	if (out.length > 1000) out = `${out.slice(0, 1000)}\u2026`;
	if (lines.length > 20) out += `\n  […${lines.length - 20} more lines]`;
	return out;
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
	"/login": "Save API key: /login <provider> <key>",
	"/logout": "Remove stored API key: /logout <provider>",
	"/help": "Show this help",
};

function helpText(): string {
	return Object.entries(COMMANDS)
		.map(([cmd, desc]) => `  ${cmd.padEnd(12)} ${desc}`)
		.join("\n");
}

export interface TuiToolSlot {
	onToolStart: ((event: ToolCallStart) => void) | undefined;
	onToolEnd: ((event: ToolCallEnd) => void) | undefined;
	onTokenUsage: ((usage: TokenUsage) => void) | undefined;
	receiveTextChunk: ((chunk: string) => void) | undefined;
	receiveThinkingChunk: ((chunk: string) => void) | undefined;
}

export async function runTuiMode(
	dialog: DialogOrgan,
	opts: InteractiveOptions,
	dispose: () => void,
	setLLMAbortController: (ctrl: AbortController | undefined) => void = () => {},
	toolSlot?: TuiToolSlot,
): Promise<void> {
	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal);
	const t = getTheme();

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

	const consoleZone = new ConsoleZone(tui, t, opts.modelId);
	consoleZone.mount();
	const { editor } = consoleZone;

	//
	// Each LLM generation phase gets its own streamingSegment. When tool calls
	// start (sealStreamingSegment), the current container is frozen in place so it
	// stays visible while tool lines are added below it. The next generation
	// creates a fresh container below the tool lines — correct chronological order.
	//
	// clearStreamingSegments() removes all accumulated live containers at turn end
	// (the final formatted reply then takes their place).

	const streamingSegments: Container[] = [];
	let streamingSegment: Container | null = null;
	let streamingMarkdownNode: Markdown | null = null;
	let streamingThinkNode: Text | null = null;
	let thinkingStartedAt = 0; // ms timestamp when first thinking chunk arrived

	// Both reply text and thinking are paced by a Typewriter for smooth letter-by-letter reveal.
	// Tick rate matches TUI.MIN_RENDER_INTERVAL_MS (16ms = 60fps) so every tick maps to one frame.
	const replyTypewriter = new Typewriter({ setText: (t) => streamingMarkdownNode?.setText(t) }, () =>
		tui.requestRender(),
	);
	const thinkTypewriter = new Typewriter({ setText: (t) => streamingThinkNode?.setText(italic(dim(t))) }, () =>
		tui.requestRender(),
	);

	function openStreamingSegment(): Container {
		if (!streamingSegment) {
			streamingSegment = new Container();
			streamingSegments.push(streamingSegment);
			chat.addChild(streamingSegment);
		}
		return streamingSegment;
	}

	function receiveTextChunk(chunk: string): void {
		consoleZone.pulse();
		const box = openStreamingSegment();
		if (!streamingMarkdownNode) {
			streamingMarkdownNode = new Markdown("", 2, 0, makeMarkdownTheme());
			box.addChild(streamingMarkdownNode);
		}
		// Feed the chunk to the typewriter — it reveals it letter-by-letter at 60fps
		// via sink.setText(revealedPrefix), which calls streamingMarkdownNode.setText().
		replyTypewriter.receive(chunk);
	}

	function receiveThinkingChunk(chunk: string): void {
		consoleZone.pulse();
		const box = openStreamingSegment();
		if (!streamingThinkNode) {
			thinkingStartedAt = Date.now();
			const t = getTheme();
			box.addChild(new Text(color(dim("┊ thinking"), t.dimFg), 2, 0));
			streamingThinkNode = new Text("", 2, 0);
			box.addChild(streamingThinkNode);
		}
		thinkTypewriter.receive(chunk);
	}

	// Seal the current generation's container so tool call lines go below it.
	// Called when the first tool call fires (generation phase ended).
	function sealStreamingSegment(): void {
		// Reply (Markdown): instant flush — Markdown manages its own colors, fade not possible.
		replyTypewriter.flush();
		replyTypewriter.reset();

		// Thinking (Text node): collapse to a compact one-liner at turn end.
		//
		// During streaming the user sees thinking text reveal in real time (Pi
		// pattern). At seal time we swap the full streamed content for a compact
		// "thought for Xs (N lines)" label so the reply is never pushed off-screen
		// by thousands of thinking chars (58s ≈ 10k chars ≈ 100+ rendered lines).
		const thinkNode = streamingThinkNode;
		const pendingThinking = thinkTypewriter.pendingText;
		thinkTypewriter.flush();
		thinkTypewriter.reset();
		if (thinkNode) {
			const elapsedS = thinkingStartedAt > 0 ? Math.round((Date.now() - thinkingStartedAt) / 1000) : 0;
			const lineCount = pendingThinking ? pendingThinking.split("\n").length : 0;
			const th = getTheme();
			const label =
				elapsedS > 0
					? `thought for ${elapsedS}s (${lineCount} lines)`
					: lineCount > 0
						? `thought (${lineCount} lines)`
						: "";
			thinkNode.setText(label ? color(dim(label), th.dimFg) : "");
			thinkingStartedAt = 0;
		}

		streamingSegment = null;
		streamingMarkdownNode = null;
		streamingThinkNode = null;
	}

	// Remove all accumulated live containers (abort / error path only).
	function clearStreamingSegments(): void {
		replyTypewriter.reset();
		thinkTypewriter.reset();
		for (const c of streamingSegments) chat.removeChild(c);
		streamingSegments.length = 0;
		streamingSegment = null;
		streamingMarkdownNode = null;
		streamingThinkNode = null;
		thinkingStartedAt = 0;
	}

	const activeCalls = new Map<string, { text: Text; name: string; keyArg: string }>();
	let pendingTokenFooter: Text | null = null;

	if (toolSlot) {
		toolSlot.onToolStart = ({ callId, name, args }) => {
			consoleZone.pulse();
			sealStreamingSegment(); // freeze current generation block; tool lines go below it
			const keyArg = keyArgFromPayload(args);
			const line = new Text(toolActiveLine(name, keyArg), 1, 0);
			activeCalls.set(callId, { text: line, name, keyArg });
			chat.addChild(line);
			tui.requestRender();
		};
		toolSlot.onToolEnd = ({ callId, elapsedMs, ok, result, display }) => {
			const entry = activeCalls.get(callId);
			if (entry) {
				entry.text.setText(renderToolLine(entry.name, entry.keyArg, elapsedMs, ok));
				activeCalls.delete(callId);
				// Prefer organ-supplied human display over raw JSON fallback.
				const snippet = display ?? result;
				if (snippet?.trim()) {
					const t = getTheme();
					chat.addChild(new Text(color(dim(truncateToolOutput(snippet)), t.dimFg), 3, 0));
				}
				tui.requestRender();
			}
		};
		toolSlot.onTokenUsage = ({ input, output }) => {
			const footer = dim(`${compact(input)} in · ${compact(output)} out`);
			if (pendingTokenFooter) {
				pendingTokenFooter.setText(footer);
				pendingTokenFooter = null;
				tui.requestRender();
			}
		};

		toolSlot.receiveTextChunk = (chunk) => receiveTextChunk(chunk);
		toolSlot.receiveThinkingChunk = (chunk) => receiveThinkingChunk(chunk);
	}

	let abortCurrentTurn: (() => void) | undefined;

	const ctx = (): TuiHandlerContext => ({
		chat,
		tui,
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
	editor.onSubmit = async (rawText: string) => {
		const text = rawText.trim();
		if (!text) return;
		if (text.startsWith("/")) {
			handleSlashCommand(text, ctx());
			return;
		}
		editor.addToHistory(text);

		if (abortCurrentTurn) {
			abortCurrentTurn();
			abortCurrentTurn = undefined;
		}

		editor.setText("");
		appendUserMsg(chat, text);
		consoleZone.startThinking();
		tui.requestRender();

		let aborted = false;
		const controller = new AbortController();
		setLLMAbortController(controller);
		abortCurrentTurn = () => {
			aborted = true;
			controller.abort();
		};

		try {
			await dialog.send(text, "human", 300_000);
			if (!aborted) {
				consoleZone.stopThinking();
				replyTypewriter.markStreamDone();
				thinkTypewriter.markStreamDone();
				if (!aborted) {
					sealStreamingSegment();
					const tokenText = new Text("", 1, 0);
					chat.addChild(tokenText);
					pendingTokenFooter = tokenText;
					tui.requestRender(true);
				}
			}
		} catch (e) {
			consoleZone.stopThinking();
			clearStreamingSegments();
			if (!aborted) appendNotice(chat, `[error] ${formatError(e)}`);
			tui.requestRender();
		} finally {
			abortCurrentTurn = undefined;
			setLLMAbortController(undefined);
			if (consoleZone.isThinking) consoleZone.stopThinking();
		}
	};

	tui.start();
	tui.setFocus(editor);
	tui.requestRender();
	trace("tui:start");

	await new Promise<void>((resolve) => {
		tui.onStop = () => {
			trace("tui:stop:resolve");
			resolve();
		};
	});

	if (consoleZone.isThinking) consoleZone.stopThinking();
	trace("tui:stopped");
}
