/**
 * TUI orchestration — wires StreamingZone, AgentBlock, ConsoleZone,
 * and the dialog.send() turn loop.
 *
 * Layout (append-only, terminal scrollback handles history):
 *
 *   StreamZone  splash · header · chat (grows into scrollback)
 *   ─────────────────────────────────────────────────────────
 *   ConsoleZone status · hint · editor (always visible)
 */

import { appendFileSync } from "node:fs";
import { getProviders } from "@dpopsuev/alef-ai";
import type { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import type { TokenUsage, ToolCallEnd, ToolCallStart } from "@dpopsuev/alef-organ-llm";
import { Container, matchesKey, ProcessTerminal, Text, TUI } from "@dpopsuev/alef-tui";
import { getStoredApiKey, removeStoredApiKey, setStoredApiKey } from "./auth.js";
import { ConsoleZone } from "./console-zone.js";
import { trace } from "./debug-trace.js";
import { formatError } from "./errors.js";
import { HistoryAutocompleteProvider } from "./history-autocomplete.js";
import type { InteractiveOptions } from "./interactive.js";
import { ModalInputHandler } from "./modal-input.js";
import { renderSplash } from "./splash.js";
import { bg, boldColor, dim, getTheme, glyph, type ThemeTokens } from "./theme.js";
import { AgentBlock, appendNotice, appendUserMsg } from "./tui/chat-view.js";
import { DynamicText } from "./tui/dynamic-text.js";

import { StreamingZone } from "./tui/streaming-zone.js";
import {
	appendCompletedToolBlock,
	formatTokenUsage,
	keyArgFromPayload,
	makeToolOutputComponent,
} from "./tui/tool-view.js";

export { makeMarkdownTheme, makeToolOutputMarkdownTheme } from "./tui/markdown-themes.js";
// Re-export primitives still used by tests and tui-commands.test.ts
export { pillFooterStr, pillHeaderStr } from "./tui/pill.js";
export { renderDiffDisplay, renderToolLine, truncateToolOutput } from "./tui/tool-view.js";

/**
 * Render the TUI header top border at a given terminal width.
 * Exported for unit testing — verifies the border fills exactly `width` visible chars.
 */
export function renderHeaderTopBorder(label: string, width: number): string {
	const inner = `─ ${label} `;
	return `╭${inner}${"─".repeat(Math.max(0, width - inner.length - 2))}╮`;
}

const ANSI_BOLD = "\x1b[1m";
const ANSI_RESET = "\x1b[0m";

// ---------------------------------------------------------------------------
// TuiHandlerContext — passed to command handlers
// ---------------------------------------------------------------------------

export interface TuiHandlerContext {
	t: ThemeTokens;
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

// ---------------------------------------------------------------------------
// Ctrl+C handler
// ---------------------------------------------------------------------------

export function handleCtrlC(ctx: TuiHandlerContext): void {
	if (ctx.abortCurrentTurn) {
		trace("ctrl+c:mid-turn");
		ctx.abortCurrentTurn();
		ctx.setAbortCurrentTurn(undefined);
		ctx.setLLMController(undefined);
		appendNotice(ctx.chat, "(interrupted)", ctx.t);
		ctx.tui.requestRender(true);
	} else {
		trace("ctrl+c:idle:dispose");
		ctx.dispose();
		trace("ctrl+c:idle:tui.stop");
		ctx.tui.stop();
		trace("ctrl+c:idle:done");
	}
}

// ---------------------------------------------------------------------------
// Slash command handler
// ---------------------------------------------------------------------------

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
			appendNotice(ctx.chat, "(conversation cleared)", ctx.t);
			ctx.tui.requestRender(true);
			return true;
		case "/resume":
			appendNotice(ctx.chat, `session: ${ctx.sessionId}`, ctx.t);
			ctx.tui.requestRender();
			return true;
		case "/login": {
			const parts = text.trim().split(/\s+/);
			const provider = parts[1];
			const key = parts.slice(2).join(" ").trim();
			if (!provider || !key) {
				const known = getProviders().slice(0, 8).join(", ");
				appendNotice(ctx.chat, `Usage: /login <provider> <api-key>\nKnown providers: ${known}`, ctx.t);
			} else {
				setStoredApiKey(provider, key);
				appendNotice(ctx.chat, `Saved API key for ${provider}. Takes effect on the next message.`, ctx.t);
			}
			ctx.tui.requestRender();
			return true;
		}
		case "/logout": {
			const provider = text.trim().split(/\s+/)[1];
			if (!provider) {
				appendNotice(ctx.chat, "Usage: /logout <provider>", ctx.t);
			} else if (!getStoredApiKey(provider)) {
				appendNotice(ctx.chat, `No stored key for ${provider}.`, ctx.t);
			} else {
				removeStoredApiKey(provider);
				appendNotice(ctx.chat, `Removed stored key for ${provider}.`, ctx.t);
			}
			ctx.tui.requestRender();
			return true;
		}
		case "/help":
			appendNotice(ctx.chat, helpText(), ctx.t);
			ctx.tui.requestRender();
			return true;
		default:
			appendNotice(ctx.chat, `Unknown command: ${cmd}. Type /help for list.`, ctx.t);
			ctx.tui.requestRender();
			return false;
	}
}

// ---------------------------------------------------------------------------
// Tool slot interface
// ---------------------------------------------------------------------------

export interface TuiToolSlot {
	onToolStart: ((event: ToolCallStart) => void) | undefined;
	onToolEnd: ((event: ToolCallEnd) => void) | undefined;
	onTokenUsage: ((usage: TokenUsage) => void) | undefined;
	receiveTextChunk: ((chunk: string) => void) | undefined;
	receiveThinkingChunk: ((chunk: string) => void) | undefined;
}

// ---------------------------------------------------------------------------
// runTuiMode — turn orchestration
// ---------------------------------------------------------------------------

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

	// TUI frame capture — written when ALEF_DEBUG=1 for offline hang diagnosis.
	// Read last frame: alef debug frame  (or: cat /tmp/alef-frames.jsonl | tail -1)
	const frameFile = "/tmp/alef-frames.jsonl";
	if (process.env.ALEF_DEBUG === "1") {
		tui.onRender = (frame: string, width: number, _height: number) => {
			try {
				const meta = tui.renderMeta;
				const record = JSON.stringify({ frame, width, ...meta });
				appendFileSync(frameFile, `${record}\n`, "utf-8");
			} catch {
				// Never crash the TUI over debug I/O.
			}
		};
	}

	// ── Header ────────────────────────────────────────────────────────────
	const sessionShort = opts.sessionId.slice(0, 8);
	const headerLabel = `${glyph("bullet")} ALEF  ${glyph("sep")}  ${sessionShort}`;
	tui.addChild(
		new DynamicText((w) => {
			const inner = `─ ${headerLabel} `;
			return boldColor(`╭${inner}${"─".repeat(Math.max(0, w - inner.length - 2))}╮`, t.accentFg);
		}),
	);
	const splash = await renderSplash();
	if (splash) tui.addChild(new Text(splash, 2, 0));
	tui.addChild(new DynamicText((w) => boldColor(`╰${"─".repeat(Math.max(0, w - 2))}╯`, t.accentFg)));

	// ── Chat container ────────────────────────────────────────────────────
	const chat = new Container();
	tui.addChild(chat);

	// ── ConsoleZone ───────────────────────────────────────────────────────
	const consoleZone = new ConsoleZone(tui, t, opts.modelId);
	consoleZone.mount();
	const { editor } = consoleZone;

	const historyProvider = new HistoryAutocompleteProvider();
	if (editor.setAutocompleteProvider) {
		editor.setAutocompleteProvider(historyProvider);
	}

	// ── Agent block + streaming zone ──────────────────────────────────────
	const agentBlock = new AgentBlock(chat, t);
	const streamingZone = new StreamingZone(agentBlock, () => tui.requestRender(), t, trace);

	// ── Tool call tracking ────────────────────────────────────────────────
	const activeCalls = new Map<string, { name: string; keyArg: string }>();
	let batchStartedAt = 0;
	let turnStartedAt = 0;
	let pendingTokenFooter: { setText(s: string): void } | null = null;

	// Show pending footer whenever the agent block opens, matching its colours.
	const agentHasBg = t.agentBg.truecolor || t.agentBg.ansi256 !== undefined || t.agentBg.ansi16 !== undefined;
	const agentBgFn = agentHasBg ? (s: string) => bg(s, t.agentBg) : null;
	const showFooter = (): void => {
		if (!agentBlock.isOpen) consoleZone.showPendingFooter(t.agentFg, agentBgFn);
	};

	if (toolSlot) {
		toolSlot.onToolStart = ({ callId, name, args }) => {
			consoleZone.pulse();
			showFooter();
			agentBlock.start();
			streamingZone.seal();
			const keyArg = keyArgFromPayload(args);
			trace("tool:start", { callId: callId.slice(0, 8), name, keyArg, activeCount: activeCalls.size + 1 });
			if (activeCalls.size === 0) batchStartedAt = Date.now();
			activeCalls.set(callId, { name, keyArg });
			consoleZone.showInFlightCall(callId, name, keyArg);
			tui.requestRender();
		};

		toolSlot.onToolEnd = ({ callId, elapsedMs, ok, result, display, displayKind }) => {
			const entry = activeCalls.get(callId);
			if (entry) {
				trace("tool:end", {
					callId: callId.slice(0, 8),
					name: entry.name,
					elapsedMs,
					ok,
					remainingActive: activeCalls.size - 1,
				});
				consoleZone.removeInFlightCall(callId);
				activeCalls.delete(callId);
				const snippet = display ?? result;
				appendCompletedToolBlock(
					agentBlock,
					entry.name,
					entry.keyArg,
					elapsedMs,
					ok,
					snippet?.trim() ? makeToolOutputComponent(snippet, displayKind, t) : null,
					t,
				);
				if (activeCalls.size === 0 && batchStartedAt > 0) {
					const batchMs = Date.now() - batchStartedAt;
					const batchStr = batchMs >= 1000 ? `${(batchMs / 1000).toFixed(1)}s` : `${batchMs}ms`;
					agentBlock.addContent(new Text(dim(`  ⊞ · ${batchStr}`), 0, 0));
					batchStartedAt = 0;
				}
				tui.requestRender();
			}
		};

		toolSlot.onTokenUsage = ({ input, output, totalTokens }) => {
			if (pendingTokenFooter) {
				pendingTokenFooter.setText(formatTokenUsage(input, output, t, Date.now() - turnStartedAt));
				pendingTokenFooter = null;
				tui.requestRender();
			}
			// Warn when context window is filling. The turn assembler drops old turns
			// but its char/4 estimates can be optimistic; actual LLM input is the ground truth.
			const cw = opts.contextWindow;
			if (cw && totalTokens > 0) {
				const fill = totalTokens / cw;
				if (fill > 0.9) {
					appendNotice(
						chat,
						`⚠ context ${Math.round(fill * 100)}% full (${totalTokens.toLocaleString()} / ${cw.toLocaleString()} tokens) — start a new session soon`,
						t,
					);
					tui.requestRender();
				} else if (fill > 0.75) {
					appendNotice(chat, `context ${Math.round(fill * 100)}% full`, t);
					tui.requestRender();
				}
			}
		};

		toolSlot.receiveTextChunk = (chunk) => {
			consoleZone.pulse();
			showFooter();
			agentBlock.start();
			streamingZone.receiveText(chunk);
		};

		toolSlot.receiveThinkingChunk = (chunk) => {
			consoleZone.pulse();
			streamingZone.receiveThinking(chunk);
		};
	}

	// ── Input handling ────────────────────────────────────────────────────
	let abortCurrentTurn: (() => void) | undefined;

	const ctx = (): TuiHandlerContext => ({
		t,
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
		if (matchesKey(data, "ctrl+t")) {
			const next = !streamingZone.hideThinking;
			streamingZone.setHideThinking(next);
			appendNotice(chat, next ? "Thinking: hidden" : "Thinking: visible", t);
			tui.requestRender();
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
		historyProvider.addEntry(text);
		agentBlock.reset(); // clear pill state for the new turn
		consoleZone.hidePendingFooter(); // guard: clear any leftover footer from prior turn
		appendUserMsg(chat, text, t);
		turnStartedAt = Date.now();
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
				streamingZone.replyTypewriter.markStreamDone();
				streamingZone.thinkTypewriter.markStreamDone();
				// seal() calls flush() which dumps pending chars in one frame; drain first.
				await Promise.all([
					streamingZone.replyTypewriter.whenDrained(),
					streamingZone.thinkTypewriter.whenDrained(),
				]);
				if (!aborted) {
					// Seal before stopThinking to avoid the empty-box flash (ALE-BUG-7).
					streamingZone.seal();
					consoleZone.stopThinking();
					consoleZone.hidePendingFooter();
					const tokenText = new Text("", 1, 0);
					agentBlock.addContent(tokenText);
					pendingTokenFooter = tokenText;
					agentBlock.end();
					tui.requestRender(true);
				}
			}
		} catch (e) {
			consoleZone.stopThinking();
			consoleZone.hidePendingFooter();
			streamingZone.clear();
			for (const [callId, entry] of activeCalls) {
				consoleZone.removeInFlightCall(callId);
				appendCompletedToolBlock(agentBlock, entry.name, entry.keyArg, 0, false, null, t);
			}
			activeCalls.clear();
			agentBlock.end();
			if (!aborted) appendNotice(chat, `[error] ${formatError(e)}`, t);
			tui.requestRender();
		} finally {
			abortCurrentTurn = undefined;
			setLLMAbortController(undefined);
			if (consoleZone.isThinking) consoleZone.stopThinking();
		}
	};

	// ── Modal input (Escape → normal mode) ────────────────────────────────
	const modal = new ModalInputHandler(
		editor,
		(mode) => {
			if (!consoleZone.isThinking) {
				consoleZone.setStatus(mode === "normal" ? dim(`${ANSI_BOLD}NORMAL${ANSI_RESET}`) : "");
			}
			tui.requestRender();
		},
		(hint) => {
			if (!consoleZone.isThinking) {
				consoleZone.setStatus(hint ? dim(hint) : dim(`${ANSI_BOLD}NORMAL${ANSI_RESET}`));
			}
			tui.requestRender();
		},
	);
	tui.addInputListener(modal.handle);

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
