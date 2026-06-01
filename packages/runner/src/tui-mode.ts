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
import type { DirectiveAdapter } from "@dpopsuev/alef-organ-alef";
import type { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import type { TokenUsage, ToolCallEnd, ToolCallStart } from "@dpopsuev/alef-organ-llm";
import { getProviders } from "@dpopsuev/alef-organ-llm";
import { Container, matchesKey, ProcessTerminal, type SelectItem, SelectList, Text, TUI } from "@dpopsuev/alef-tui";
import { getStoredApiKey, removeStoredApiKey, setStoredApiKey } from "./auth.js";
import { ConsoleZone } from "./console-zone.js";
import { trace } from "./debug-trace.js";
import { formatError } from "./errors.js";
import { HistoryAutocompleteProvider } from "./history-autocomplete.js";
import type { InteractiveOptions } from "./interactive.js";
import { COLON_COMMANDS, ModalInputHandler } from "./modal-input.js";
import { buildModel } from "./model.js";
import { renderSplash } from "./splash.js";
import { boldColor, color, getTheme, glyph, setThemeByName, type ThemeTokens } from "./theme.js";
import { ChatWriter } from "./tui/chat-writer.js";
import { DynamicText } from "./tui/dynamic-text.js";

import { StreamingZone } from "./tui/streaming-zone.js";
import { formatTokenUsage, keyArgFromPayload, makeToolOutputComponent } from "./tui/tool-view.js";
import { Typewriter } from "./tui/typewriter.js";

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
	dialog: DialogOrgan;
	dispose(): void;
	sessionId: string;
	abortCurrentTurn: (() => void) | undefined;
	setAbortCurrentTurn(fn: (() => void) | undefined): void;
	setLLMController(ctrl: AbortController | undefined): void;
	/** Hot-reload a named organ by path (ALE-TSK-348). Undefined when not supported. */
	reloadOrgan?: (name: string, path: string) => Promise<void>;
	/** Returns the active prompt scroll adapter, or undefined when unavailable. */
	getDirective?: () => DirectiveAdapter | undefined;
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
		ctx.writer.addNotice("(interrupted)");
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
	const colonLines = Object.entries(COLON_COMMANDS)
		.map(([cmd, desc]) => `  ${cmd.padEnd(12)} ${desc}`)
		.join("\n");
	return `Normal-mode commands (press ':' then type):\n${colonLines}\n\nInsert-mode slash aliases:\n${slashLines}`;
}

export function handleSlashCommand(text: string, ctx: TuiHandlerContext): boolean {
	const cmd = text.split(" ")[0].toLowerCase();
	switch (cmd) {
		case "/exit":
			ctx.dispose();
			ctx.tui.stop();
			return true;
		case "/new":
			ctx.writer.clearAll();
			ctx.writer.addNotice("(conversation cleared)");
			ctx.tui.requestRender(true);
			return true;
		case "/resume":
			ctx.writer.addNotice(`session: ${ctx.sessionId}`);
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
	const cmd = (parts[0] ?? "").toLowerCase();
	switch (cmd) {
		case ":q":
		case ":quit":
		case ":exit":
			ctx.dispose();
			ctx.tui.stop();
			return true;
		case ":new":
		case ":clear":
			ctx.writer.clearAll();
			ctx.writer.addNotice("(conversation cleared)");
			ctx.tui.requestRender(true);
			return true;
		case ":session":
			ctx.writer.addNotice(`session: ${ctx.sessionId}`);
			ctx.tui.requestRender();
			return true;
		case ":login": {
			const provider = parts[1];
			const key = parts.slice(2).join(" ").trim();
			if (!provider || !key) {
				const known = getProviders().slice(0, 8).join(", ");
				ctx.writer.addNotice(`Usage: :login <provider> <api-key>\nKnown providers: ${known}`);
			} else {
				setStoredApiKey(provider, key);
				ctx.writer.addNotice(`Saved API key for ${provider}. Takes effect on the next message.`);
			}
			ctx.tui.requestRender();
			return true;
		}
		case ":logout": {
			const provider = parts[1];
			if (!provider) {
				ctx.writer.addNotice("Usage: :logout <provider>");
			} else if (!getStoredApiKey(provider)) {
				ctx.writer.addNotice(`No stored key for ${provider}.`);
			} else {
				removeStoredApiKey(provider);
				ctx.writer.addNotice(`Removed stored key for ${provider}.`);
			}
			ctx.tui.requestRender();
			return true;
		}
		case ":help":
		case ":h":
			ctx.writer.addNotice(helpText());
			ctx.tui.requestRender();
			return true;
		case ":reload": {
			const organName = parts[1];
			const organPath = parts[2];
			if (!organName || !organPath) {
				ctx.writer.addNotice("Usage: :reload <name> <path>");
				ctx.tui.requestRender();
				return true;
			}
			if (!ctx.reloadOrgan) {
				ctx.writer.addNotice(":reload not available in this session.");
				ctx.tui.requestRender();
				return true;
			}
			ctx.writer.addNotice(`Reloading ${organName}…`);
			ctx.tui.requestRender();
			ctx.reloadOrgan(organName, organPath)
				.then(() => {
					ctx.writer.addNotice(`Reloaded ${organName}.`);
					ctx.tui.requestRender();
				})
				.catch((e: unknown) => {
					ctx.writer.addNotice(`Reload failed: ${e instanceof Error ? e.message : String(e)}`);
					ctx.tui.requestRender();
				});
			return true;
		}
		case ":install": {
			const spec = parts[1];
			if (!spec) {
				ctx.writer.addNotice("Usage: :install <organ>[@version]");
				ctx.tui.requestRender();
				return true;
			}
			ctx.writer.addNotice(`Installing ${spec}…`);
			ctx.tui.requestRender();
			import("./alef-pm.js")
				.then(async (pm) => {
					pm.init();
					const [name, version] = spec.split("@");
					const gen = await pm.install(name, version);
					ctx.writer.addNotice(`Installed ${spec} (generation ${gen})`);
					ctx.tui.requestRender();
				})
				.catch((e: unknown) => {
					ctx.writer.addNotice(`Install failed: ${e instanceof Error ? e.message : String(e)}`);
					ctx.tui.requestRender();
				});
			return true;
		}
		case ":upgrade": {
			ctx.writer.addNotice("Upgrading organs…");
			ctx.tui.requestRender();
			import("./alef-pm.js")
				.then(async (pm) => {
					pm.init();
					const gen = await pm.upgrade();
					ctx.writer.addNotice(`Organs upgraded (generation ${gen})`);
					ctx.tui.requestRender();
				})
				.catch((e: unknown) => {
					ctx.writer.addNotice(`Upgrade failed: ${e instanceof Error ? e.message : String(e)}`);
					ctx.tui.requestRender();
				});
			return true;
		}
		case ":rollback": {
			import("./alef-pm.js")
				.then(async (pm) => {
					pm.init();
					const entries = pm.history();
					const n = parts[1] ? parseInt(parts[1], 10) : (entries[1]?.id ?? 1);
					await pm.rollback(n);
					ctx.writer.addNotice(`Rolled back to generation ${n}. Restart Alef to load the restored organs.`);
					ctx.tui.requestRender();
				})
				.catch((e: unknown) => {
					ctx.writer.addNotice(`Rollback failed: ${e instanceof Error ? e.message : String(e)}`);
					ctx.tui.requestRender();
				});
			return true;
		}
		case ":meta": {
			const prompt = parts.slice(1).join(" ").trim();
			if (!prompt) {
				ctx.writer.addNotice("Usage: :meta <free text prompt>\nExample: :meta list my sessions from last week");
				ctx.tui.requestRender();
				return true;
			}
			ctx.writer.addUserMessage(`[meta] ${prompt}`);
			ctx.tui.requestRender();
			import("./meta-agent.js")
				.then(async (m) => {
					const chunks: string[] = [];
					const reply = await m.runMetaAgent(
						prompt,
						ctx.opts?.getModel?.(),
						(chunk) => {
							chunks.push(chunk);
							ctx.writer.addNotice(`[meta] ${chunks.join("")}`);
							ctx.tui.requestRender();
						},
						ctx.getDirective,
					);
					// Final settled reply (in case streaming wasn't available)
					if (chunks.length === 0 && reply) {
						ctx.writer.addNotice(`[meta] ${reply}`);
						ctx.tui.requestRender();
					}
				})
				.catch((e: unknown) => {
					ctx.writer.addNotice(`[meta] error: ${e instanceof Error ? e.message : String(e)}`);
					ctx.tui.requestRender();
				});
			return true;
		}
		case ":directive": {
			const scroll = ctx.getDirective?.();
			if (!scroll) {
				ctx.writer.addNotice(":directive not available in this session.");
				ctx.tui.requestRender();
				return true;
			}
			const sub = (parts[1] ?? "").toLowerCase();
			const id = parts[2];
			switch (sub) {
				case "list":
				case "": {
					const blocks = scroll.list();
					const lines = blocks.map(
						(b) =>
							`  [${b.priority}] ${b.enabled ? "●" : "○"} ${b.id}${b.tags?.length ? ` (${b.tags.join(", ")})` : ""}`,
					);
					ctx.writer.addNotice(`Prompt scroll blocks:\n${lines.join("\n")}`);
					break;
				}
				case "enable":
					if (!id) {
						ctx.writer.addNotice("Usage: :directive enable <id>");
						break;
					}
					scroll.enable(id);
					ctx.writer.addNotice(`● Block '${id}' enabled. Takes effect next turn.`);
					break;
				case "disable":
					if (!id) {
						ctx.writer.addNotice("Usage: :directive disable <id>");
						break;
					}
					scroll.disable(id);
					ctx.writer.addNotice(`○ Block '${id}' disabled. Takes effect next turn.`);
					break;
				case "toggle":
					if (!id) {
						ctx.writer.addNotice("Usage: :directive toggle <id>");
						break;
					}
					scroll.toggle(id);
					ctx.writer.addNotice(`Toggled block '${id}'. Takes effect next turn.`);
					break;
				case "reset":
					ctx.writer.addNotice("Use :meta 'reset the prompt scroll to defaults' to restore all blocks.");
					break;
				default:
					ctx.writer.addNotice("Usage: :directive list | enable <id> | disable <id> | toggle <id>");
			}
			ctx.tui.requestRender();
			return true;
		}
		case ":theme": {
			const themes = ["terminal", "terminal-light", "akko", "mono", "matrix"];
			const name = parts[1]?.toLowerCase();
			if (!name) {
				ctx.writer.addNotice(`Available themes: ${themes.join("  ")}\nUsage: :theme <name>`);
				ctx.tui.requestRender();
				return true;
			}
			if (!themes.includes(name)) {
				ctx.writer.addNotice(`Unknown theme '${name}'. Available: ${themes.join(", ")}`);
				ctx.tui.requestRender();
				return true;
			}
			setThemeByName(name);
			ctx.writer.addNotice(`Theme set to '${name}'.`);
			ctx.tui.requestRender(true);
			return true;
		}
		case ":model": {
			const newId = parts[1];
			if (!newId) {
				const current = ctx.opts?.getModel?.() ?? "unknown";
				ctx.writer.addNotice(`Current model: ${current}\nUsage: :model <id>  (e.g. :model claude-sonnet-4-6)`);
				ctx.tui.requestRender();
				return true;
			}
			try {
				const built = buildModel(newId);
				ctx.opts?.setModel?.(newId);
				ctx.writer.addNotice(`Model switched to ${built.id}. Takes effect on the next message.`);
			} catch (e) {
				ctx.writer.addNotice(`Unknown model: ${newId}. ${e instanceof Error ? e.message : ""}`);
			}
			ctx.tui.requestRender();
			return true;
		}
		case ":think": {
			const VALID_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
			const level = parts[1];
			if (!level) {
				const current = ctx.opts?.getThinking?.() ?? "off";
				ctx.writer.addNotice(`Thinking: ${current}\nUsage: :think <level>  (${VALID_LEVELS.join(" | ")})`);
				ctx.tui.requestRender();
				return true;
			}
			if (!VALID_LEVELS.includes(level as (typeof VALID_LEVELS)[number])) {
				ctx.writer.addNotice(`Unknown thinking level: ${level}. Valid: ${VALID_LEVELS.join(" | ")}`);
				ctx.tui.requestRender();
				return true;
			}
			ctx.opts?.setThinking?.(level);
			ctx.writer.addNotice(`Thinking set to "${level}". Takes effect on the next message.`);
			ctx.tui.requestRender();
			return true;
		}
		default:
			ctx.writer.addNotice(`Unknown command: ${cmd}. Type :help for list or :h for help.`);
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
	reloadOrgan?: (name: string, path: string) => Promise<void>,
	getDirective?: () => DirectiveAdapter | undefined,
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

	if (toolSlot) {
		toolSlot.onToolStart = ({ callId, name, args }) => {
			consoleZone.pulse();
			showFooter();
			replyTW.flush();
			thinkingTW.flush();
			streamingZone.reset(); // close @alef block so post-tool text opens a new one
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
				writer.addCompletedToolBlock(
					entry.name,
					entry.keyArg,
					elapsedMs,
					ok,
					snippet?.trim() ? makeToolOutputComponent(snippet, displayKind, t) : null,
				);
				if (activeCalls.size === 0 && batchStartedAt > 0) {
					writer.addBatchTiming(Date.now() - batchStartedAt);
					batchStartedAt = 0;
				}
				tui.requestRender();
			}
		};

		toolSlot.onTokenUsage = ({ input, output, totalTokens }) => {
			sessionTokens.total += input + output;
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
					writer.addNotice(
						`⚠ context ${Math.round(fill * 100)}% full (${totalTokens.toLocaleString()} / ${cw.toLocaleString()} tokens) — start a new session soon`,
					);
					tui.requestRender();
				} else if (fill > 0.75) {
					writer.addNotice(`context ${Math.round(fill * 100)}% full`);
					tui.requestRender();
				}
			}
		};

		toolSlot.receiveTextChunk = (chunk) => {
			consoleZone.pulse();
			showFooter();
			replyTW.receive(chunk);
		};

		toolSlot.receiveThinkingChunk = (chunk) => {
			consoleZone.pulse();
			thinkingTW.receive(chunk);
		};
	}

	// ── Input handling ────────────────────────────────────────────────────
	let abortCurrentTurn: (() => void) | undefined;

	const ctx = (): TuiHandlerContext => ({
		t,
		writer,
		tui,
		dialog,
		dispose,
		opts,
		sessionId: opts.sessionId,
		abortCurrentTurn,
		setAbortCurrentTurn: (fn) => {
			abortCurrentTurn = fn;
		},
		setLLMController: (ctrl) => {
			setLLMAbortController(ctrl);
		},
		reloadOrgan,
		getDirective,
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
		setLLMAbortController(controller);
		abortCurrentTurn = () => {
			aborted = true;
			controller.abort();
		};

		try {
			await dialog.send(text, "human", 300_000);
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
			setLLMAbortController(undefined);
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

	await new Promise<void>((resolve) => {
		tui.onStop = () => {
			trace("tui:stop:resolve");
			resolve();
		};
	});

	if (consoleZone.isThinking) consoleZone.stopThinking();
	trace("tui:stopped");
}
