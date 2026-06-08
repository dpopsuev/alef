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
import type { TuiHandlerContext } from "./commands/types.js";
import { ConsoleZone } from "./console-zone.js";
import { trace } from "./debug-trace.js";

import { HistoryAutocompleteProvider } from "./history-autocomplete.js";
import type { InteractiveOptions } from "./interactive.js";
import { ModalInputHandler } from "./modal-input.js";
import type { Session } from "./session.js";
import { renderSplash } from "./splash.js";
import { boldColor, color, getTheme, glyph } from "./theme.js";
import { ChatWriter } from "./tui/chat-writer.js";
import { DynamicText } from "./tui/dynamic-text.js";
import { StreamingZone } from "./tui/streaming-zone.js";

import { Typewriter } from "./tui/typewriter.js";
import { handleAgentEvent, handleTurnError } from "./tui-reducer.js";
import { initialTuiState, syncOverlays, type TuiUi } from "./tui-state.js";
import { checkForUpdate } from "./version-check.js";

export { makeMarkdownTheme, makeToolOutputMarkdownTheme } from "./tui/markdown-themes.js";
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

export type { TuiHandlerContext } from "./commands/types.js";

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

	// ── Agent event dispatch ──────────────────────────────────────────────
	let tuiState = initialTuiState();
	const tuiUi: TuiUi = { writer, streamingZone, replyTW, thinkingTW, consoleZone, tui, t, session };

	session.subscribe((event) => {
		const prev = tuiState;
		tuiState = handleAgentEvent(tuiState, event, tuiUi);
		syncOverlays(tui, prev.overlays, tuiState.overlays);
		tui.requestRender();
	});

	// ── Input handling ────────────────────────────────────────────────────
	const ctx = (): TuiHandlerContext => ({
		t,
		writer,
		tui,
		opts,
		session,
		abortCurrentTurn: tuiState.abortCurrentTurn,
		setAbortCurrentTurn: (fn) => {
			tuiState = { ...tuiState, abortCurrentTurn: fn };
		},
	});

	const HISTORY_PICKER_ID = "history-picker";

	const closeHistoryPicker = (): void => {
		const prev = tuiState;
		tuiState = { ...tuiState, overlays: tuiState.overlays.filter((o) => o.id !== HISTORY_PICKER_ID) };
		syncOverlays(tui, prev.overlays, tuiState.overlays);
		tui.requestRender();
	};

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
		list.onSelect = (item: SelectItem) => {
			editor.setText(item.value);
			closeHistoryPicker();
		};
		list.onCancel = () => closeHistoryPicker();
		const prev = tuiState;
		tuiState = {
			...tuiState,
			overlays: [
				...tuiState.overlays,
				{ id: HISTORY_PICKER_ID, component: list, handleInput: (d) => list.handleInput(d) },
			],
		};
		syncOverlays(tui, prev.overlays, tuiState.overlays);
		tui.requestRender();
		return true;
	};

	tui.onRawInput = (data) => {
		// Ctrl+R — history picker (Insert and Normal mode)
		if (data === "\x12") {
			const picker = tuiState.overlays.find((o) => o.id === HISTORY_PICKER_ID);
			if (picker) {
				picker.handleInput?.("\x1b"); // close on second Ctrl+R
			} else {
				openHistoryPicker();
			}
			return true;
		}
		const activeOverlay = tuiState.overlays.find((o) => o.handleInput);
		if (activeOverlay?.handleInput) {
			activeOverlay.handleInput(data);
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
		if (tuiState.abortCurrentTurn) {
			tuiState.abortCurrentTurn();
			tuiState = { ...tuiState, abortCurrentTurn: undefined };
		}
		editor.setText("");
		historyProvider.addEntry(text);
		tuiState = { ...tuiState, pendingFooterShown: false, turnStartedAt: Date.now() };
		consoleZone.hidePendingFooter();
		writer.addUserMessage(text);
		consoleZone.startThinking();
		tui.requestRender();

		let aborted = false;
		const controller = new AbortController();
		session.setTurnController(controller);
		tuiState = {
			...tuiState,
			abortCurrentTurn: () => {
				aborted = true;
				controller.abort();
			},
		};

		try {
			if (session.send) await session.send(text, 300_000);
			if (!aborted) {
				replyTW.flush();
				thinkingTW.flush();
				streamingZone.reset();
				consoleZone.stopThinking();
				consoleZone.hidePendingFooter();
				tuiState = { ...tuiState, pendingFooterShown: false, pendingTokenFooter: writer.addTokenFooter() };
				tui.requestRender(true);
			}
		} catch (e) {
			tuiState = handleTurnError(tuiState, e, aborted, tuiUi);
			tui.requestRender();
		} finally {
			tuiState = { ...tuiState, abortCurrentTurn: undefined };
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
