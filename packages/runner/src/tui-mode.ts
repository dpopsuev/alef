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
import { Container, matchesKey, ProcessTerminal, type SelectItem, SelectList, Text, TUI } from "@dpopsuev/alef-tui";
import { getStoredApiKey, removeStoredApiKey, setStoredApiKey } from "./auth.js";
import { registry } from "./commands/index.js";
import { ConsoleZone } from "./console-zone.js";
import { trace } from "./debug-trace.js";
import { formatError } from "./errors.js";
import { HistoryAutocompleteProvider } from "./history-autocomplete.js";
import type { InteractiveOptions } from "./interactive.js";
import { ModalInputHandler } from "./modal-input.js";
import type { Session } from "./session.js";
import { renderSplash } from "./splash.js";
import { boldColor, color, getTheme, glyph, type ThemeTokens } from "./theme.js";
import { ChatWriter } from "./tui/chat-writer.js";
import { DynamicText } from "./tui/dynamic-text.js";
import { StreamingZone } from "./tui/streaming-zone.js";
import { formatTokenUsage, keyArgFromPayload, makeToolOutputComponent } from "./tui/tool-view.js";
import { Typewriter } from "./tui/typewriter.js";
import { checkForUpdate } from "./version-check.js";

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
	writer: ChatWriter;
	opts?: InteractiveOptions;
	tui: {
		stop(): void;
		removeChild(c: unknown): void;
		addChild(c: unknown): void;
		requestRender(force?: boolean): void;
	};
	session: Session;
	abortCurrentTurn: (() => void) | undefined;
	setAbortCurrentTurn(fn: (() => void) | undefined): void;
}

// ---------------------------------------------------------------------------
// Ctrl+C handler
// ---------------------------------------------------------------------------

export function handleCtrlC(ctx: TuiHandlerContext): void {
	if (ctx.abortCurrentTurn) {
		trace("ctrl+c:mid-turn");
		ctx.abortCurrentTurn();
		ctx.setAbortCurrentTurn(undefined);
		ctx.session.setTurnController(undefined);
		ctx.writer.addNotice("(interrupted)");
		ctx.tui.requestRender(true);
	} else {
		trace("ctrl+c:idle:dispose");
		ctx.session.dispose();
		trace("ctrl+c:idle:tui.stop");
		ctx.tui.stop();
		trace("ctrl+c:idle:done");
	}
}

// ---------------------------------------------------------------------------
// Slash command handler
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Slash commands — Insert-mode aliases (e.g. typing /exit in the editor).
// In Normal mode, use ':' commands instead (Neovim convention).
// ---------------------------------------------------------------------------
const COMMANDS: Record<string, string> = {
	"/exit": "Quit (alias: :q)",
	"/new": "Clear conversation (alias: :new)",
	"/resume": "Show session ID (alias: :session)",
	"/login": "Save API key: /login <provider> <key>",
	"/logout": "Remove stored API key: /logout <provider>",
	"/help": "Show this help",
};

function helpText(): string {
	const slashLines = Object.entries(COMMANDS)
		.map(([cmd, desc]) => `  ${cmd.padEnd(12)} ${desc}`)
		.join("\n");
	const colonLines = registry
		.list()
		.map((c) => `  :${c.name.padEnd(11)} ${c.description}`)
		.join("\n");
	return `Normal-mode commands (press ':' then type):\n${colonLines}\n\nInsert-mode slash aliases:\n${slashLines}`;
}

export function handleSlashCommand(text: string, ctx: TuiHandlerContext): boolean {
	const cmd = text.split(" ")[0].toLowerCase();
	switch (cmd) {
		case "/exit":
			ctx.session.dispose();
			ctx.tui.stop();
			return true;
		case "/new":
			ctx.writer.clearAll();
			ctx.writer.addNotice("(conversation cleared)");
			ctx.tui.requestRender(true);
			return true;
		case "/resume":
			ctx.writer.addNotice(`session: ${ctx.session.state.id}`);
			ctx.tui.requestRender();
			return true;
		case "/login": {
			const parts = text.trim().split(/\s+/);
			const provider = parts[1];
			const key = parts.slice(2).join(" ").trim();
			if (!provider || !key) {
				const known = getProviders().slice(0, 8).join(", ");
				ctx.writer.addNotice(`Usage: /login <provider> <api-key>\nKnown providers: ${known}`);
			} else {
				setStoredApiKey(provider, key);
				ctx.writer.addNotice(`Saved API key for ${provider}. Takes effect on the next message.`);
			}
			ctx.tui.requestRender();
			return true;
		}
		case "/logout": {
			const provider = text.trim().split(/\s+/)[1];
			if (!provider) {
				ctx.writer.addNotice("Usage: /logout <provider>");
			} else if (!getStoredApiKey(provider)) {
				ctx.writer.addNotice(`No stored key for ${provider}.`);
			} else {
				removeStoredApiKey(provider);
				ctx.writer.addNotice(`Removed stored key for ${provider}.`);
			}
			ctx.tui.requestRender();
			return true;
		}
		case "/help":
			ctx.writer.addNotice(helpText());
			ctx.tui.requestRender();
			return true;
		default:
			ctx.writer.addNotice(`Unknown command: ${cmd}. Type /help for list.`);
			ctx.tui.requestRender();
			return false;
	}
}

// ---------------------------------------------------------------------------
// Colon command handler — Normal-mode ':commands' (Neovim convention).
// Dispatched by ModalInputHandler when user types ':cmd' and presses Enter.
// ---------------------------------------------------------------------------

export function handleColonCommand(text: string, ctx: TuiHandlerContext): boolean {
	const parts = text.trim().split(/\s+/);
	const name = (parts[0] ?? "").replace(/^:/, "").toLowerCase();
	const cmd = registry.find(name);
	if (!cmd) {
		ctx.writer.addNotice(`Unknown command: :. Type :help for list.`);
		ctx.tui.requestRender();
		return false;
	}
	void cmd.run(ctx, parts.slice(1));
	return true;
}

// ---------------------------------------------------------------------------
// runTuiMode — turn orchestration
// ---------------------------------------------------------------------------

export async function runTuiMode(session: Session, opts: InteractiveOptions): Promise<void> {
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
	const modelShort = opts.modelId.split("/").pop()?.split(" ")[0] ?? opts.modelId;
	const sessionTokens = { total: 0 };
	const headerLabel = () => {
		const base = `${glyph("bullet")} ALEF  ${glyph("sep")}  ${sessionShort}  ${glyph("sep")}  ${modelShort}`;
		if (sessionTokens.total === 0) return base;
		const n = sessionTokens.total;
		const fmt =
			n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n);
		return `${base}  ${glyph("sep")}  ${fmt} tok`;
	};
	tui.addChild(
		new DynamicText((w) => {
			const inner = `─ ${headerLabel()} `;
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
	const writer = new ChatWriter(chat, t);
	const streamingZone = new StreamingZone(chat, () => tui.requestRender(), t);
	const replyTW = new Typewriter(
		(delta) => streamingZone.receiveText(delta),
		() => tui.requestRender(),
	);
	const thinkingTW = new Typewriter(
		(delta) => streamingZone.receiveThinking(delta),
		() => tui.requestRender(),
	);

	// ── Tool call tracking ────────────────────────────────────────────────
	const activeCalls = new Map<string, { name: string; keyArg: string }>();
	let batchStartedAt = 0;
	let turnStartedAt = 0;
	let pendingTokenFooter: { setText(s: string): void } | null = null;

	let pendingFooterShown = false;
	const showFooter = (): void => {
		if (!pendingFooterShown) {
			consoleZone.showPendingFooter(t.agentFg);
			pendingFooterShown = true;
		}
	};

	session.subscribe((event) => {
		switch (event.type) {
			case "tool-start": {
				const { callId, name, args } = event;
				consoleZone.pulse();
				showFooter();
				replyTW.flush();
				thinkingTW.flush();
				streamingZone.reset();
				const keyArg = keyArgFromPayload(args);
				trace("tool:start", { callId: callId.slice(0, 8), name, keyArg, activeCount: activeCalls.size + 1 });
				if (activeCalls.size === 0) batchStartedAt = Date.now();
				activeCalls.set(callId, { name, keyArg });
				consoleZone.showInFlightCall(callId, name, keyArg);
				tui.requestRender();
				break;
			}
			case "tool-validation-error": {
				// Schema rejected the LLM's tool arguments — surface inline so the LLM sees
				// a clear retry hint rather than a raw zod error in the toolResult text.
				consoleZone.pulse();
				consoleZone.updateInFlightCallChunk(event.callId, `\u26a0 invalid arg '${event.field}': ${event.message}`);
				tui.requestRender();
				break;
			}
			case "tool-stall": {
				// Tool has been running without emitting any chunks for STALL_INTERVAL_MS.
				// Makes silent long-running tools visible instead of just showing a counter.
				consoleZone.pulse();
				consoleZone.updateInFlightCallChunk(
					event.callId,
					`\u23f3 no output for ${Math.round(event.lastChunkMs / 1_000)}s`,
				);
				tui.requestRender();
				break;
			}
			case "tool-chunk": {
				// Streaming progress from a long-running tool (shell.exec, agent.run).
				// Update the in-flight pill's live text so the user sees activity.
				consoleZone.pulse();
				consoleZone.updateInFlightCallChunk(event.callId, event.text);
				tui.requestRender();
				break;
			}
			case "tool-end": {
				const { callId, elapsedMs, ok, display, displayKind } = event;
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
					writer.addCompletedToolBlock(
						entry.name,
						entry.keyArg,
						elapsedMs,
						ok,
						display?.trim() ? makeToolOutputComponent(display, displayKind, t) : null,
					);
					if (activeCalls.size === 0 && batchStartedAt > 0) {
						writer.addBatchTiming(Date.now() - batchStartedAt);
						batchStartedAt = 0;
					}
					tui.requestRender();
				}
				break;
			}
			case "token-usage": {
				const { input, output, totalTokens } = event.usage;
				sessionTokens.total += input + output;
				if (pendingTokenFooter) {
					pendingTokenFooter.setText(formatTokenUsage(input, output, t, Date.now() - turnStartedAt));
					pendingTokenFooter = null;
					tui.requestRender();
				}
				const cw = session.state.contextWindow;
				if (cw && totalTokens > 0) {
					const fill = totalTokens / cw;
					if (fill > 0.9) {
						writer.addNotice(
							`⚠ context ${Math.round(fill * 100)}% full (${totalTokens.toLocaleString()} / ${cw.toLocaleString()} tokens) — start a new session soon`,
						);
						tui.requestRender();
					} else if (fill > 0.75) {
						writer.addNotice(`context ${Math.round(fill * 100)}% full`);
						tui.requestRender();
					}
				}
				break;
			}
			case "chunk":
				consoleZone.pulse();
				showFooter();
				replyTW.receive(event.text);
				break;
			case "thinking":
				consoleZone.pulse();
				thinkingTW.receive(event.text);
				break;
		}
	});

	// ── Input handling ────────────────────────────────────────────────────
	let abortCurrentTurn: (() => void) | undefined;

	const ctx = (): TuiHandlerContext => ({
		t,
		writer,
		tui,
		opts,
		session,
		abortCurrentTurn,
		setAbortCurrentTurn: (fn) => {
			abortCurrentTurn = fn;
		},
	});

	// Ctrl+R: open inline history picker. Populated after each submit.
	let historyPickerActive = false;
	let historyPickerList: SelectList | null = null;

	const openHistoryPicker = (): boolean => {
		const entries = historyProvider.getEntries();
		if (entries.length === 0) return false;
		const items: SelectItem[] = entries.map((e) => ({
			value: e,
			label: e.length > 60 ? `${e.slice(0, 60)}…` : e,
		}));
		const pickTheme = {
			selectedPrefix: (s: string) => color(s, t.accentFg),
			selectedText: (s: string) => boldColor(s, t.accentFg),
			description: (s: string) => color(s, t.dimFg),
			scrollInfo: (s: string) => color(s, t.dimFg),
			noMatch: (s: string) => color(s, t.dimFg),
		};
		const list = new SelectList(items, 6, pickTheme);
		historyPickerList = list;
		historyPickerActive = true;
		list.onSelect = (item: SelectItem) => {
			editor.setText(item.value);
			tui.removeChild(list);
			historyPickerActive = false;
			historyPickerList = null;
			tui.requestRender();
		};
		list.onCancel = () => {
			tui.removeChild(list);
			historyPickerActive = false;
			historyPickerList = null;
			tui.requestRender();
		};
		tui.addChild(list);
		tui.requestRender();
		return true;
	};

	tui.onRawInput = (data) => {
		// Ctrl+R — history picker (Insert and Normal mode)
		if (data === "\x12") {
			if (historyPickerActive && historyPickerList) {
				historyPickerList.handleInput("\x1b"); // close on second Ctrl+R
			} else {
				openHistoryPicker();
			}
			return true;
		}
		if (historyPickerActive && historyPickerList) {
			historyPickerList.handleInput(data);
			tui.requestRender();
			return true;
		}
		if (matchesKey(data, "ctrl+c")) {
			trace("raw:ctrl+c", { seq: JSON.stringify(data) });
			handleCtrlC(ctx());
			return true;
		}
		if (matchesKey(data, "ctrl+t")) {
			const next = !streamingZone.hideThinking;
			streamingZone.setHideThinking(next);
			writer.addNotice(next ? "Thinking: hidden" : "Thinking: visible");
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
		pendingFooterShown = false;
		consoleZone.hidePendingFooter(); // guard: clear any leftover footer from prior turn
		writer.addUserMessage(text);
		turnStartedAt = Date.now();
		consoleZone.startThinking();
		tui.requestRender();

		let aborted = false;
		const controller = new AbortController();
		session.setTurnController(controller);
		abortCurrentTurn = () => {
			aborted = true;
			controller.abort();
		};

		try {
			if (session.send) await session.send(text, 300_000);
			if (!aborted) {
				replyTW.flush();
				thinkingTW.flush();
				streamingZone.reset();
				consoleZone.stopThinking();
				consoleZone.hidePendingFooter();
				pendingFooterShown = false;
				pendingTokenFooter = writer.addTokenFooter();
				tui.requestRender(true);
			}
		} catch (e) {
			consoleZone.stopThinking();
			consoleZone.hidePendingFooter();
			replyTW.reset();
			thinkingTW.reset();
			streamingZone.clear();
			for (const [callId, entry] of activeCalls) {
				consoleZone.removeInFlightCall(callId);
				writer.addCompletedToolBlock(entry.name, entry.keyArg, 0, false, null);
			}
			activeCalls.clear();
			if (!aborted) writer.addNotice(`[error] ${formatError(e)}`);
			tui.requestRender();
		} finally {
			abortCurrentTurn = undefined;
			session.setTurnController(undefined);
			if (consoleZone.isThinking) consoleZone.stopThinking();
		}
	};

	// ── Modal input (Escape → normal mode) ────────────────────────────────
	const modal = new ModalInputHandler(
		editor,
		// onModeChange: update status bar indicator
		(mode) => {
			if (!consoleZone.isThinking) {
				consoleZone.setStatus(mode === "normal" ? color(`${ANSI_BOLD}NORMAL${ANSI_RESET}`, t.dimFg) : "");
			}
			tui.requestRender();
		},
		// onHint: which-key hint or ':cmdBuffer' in command mode
		(hint) => {
			if (!consoleZone.isThinking) {
				consoleZone.setStatus(hint ? color(hint, t.dimFg) : color(`${ANSI_BOLD}NORMAL${ANSI_RESET}`, t.dimFg));
			}
			tui.requestRender();
		},
		// onColonCommand: dispatch ':cmd' executed from Normal mode
		(colonCmd) => {
			handleColonCommand(colonCmd, ctx());
		},
	);
	tui.addInputListener(modal.handle);

	tui.start();
	tui.setFocus(editor);
	tui.requestRender();
	trace("tui:start");
	// Signal for smoke tests: TUI is fully initialised and accepting input.
	// Written only when ALEF_DEBUG=1 to avoid polluting normal output.
	if (process.env.ALEF_DEBUG === "1") process.stdout.write("[ALEF_READY]\n");

	checkForUpdate()
		.then((notice) => {
			if (notice) {
				writer.addNotice(notice);
				tui.requestRender();
			}
		})
		.catch(() => {});

	await new Promise<void>((resolve) => {
		tui.onStop = () => {
			trace("tui:stop:resolve");
			resolve();
		};
	});

	if (consoleZone.isThinking) consoleZone.stopThinking();
	trace("tui:stopped");
}
