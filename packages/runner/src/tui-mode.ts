/**
 * TUI interactive mode — full terminal UI for Alef.
 *
 * Layout (top to bottom):
 *   header     — "Alef · model · session:id"
 *   chat       — conversation history (Text blocks)
 *   loader     — "● Thinking…" (while agent runs)
 *   hint/input — single-line Input with slash command hint
 *
 * Slash commands: /exit /new /resume /help
 * Ctrl+C: interrupt current turn or quit if idle.
 */

import type { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import type { MarkdownTheme } from "@dpopsuev/alef-tui";
import { Container, Input, Loader, Markdown, ProcessTerminal, Spacer, Text, TUI } from "@dpopsuev/alef-tui";
import { formatError } from "./errors.js";
import type { InteractiveOptions } from "./interactive.js";

// ---------------------------------------------------------------------------
// Handler context — passed to extracted handler functions for testability.
// Tests construct this directly with mock collaborators.
// ---------------------------------------------------------------------------

export interface TuiHandlerContext {
	chat: Container;
	tui: {
		stop(): void;
		removeChild(c: unknown): void;
		addChild(c: unknown): void;
		requestRender(force?: boolean): void;
	};
	hint: unknown;
	loader: unknown;
	dialog: { clearHistory(): void };
	dispose(): void;
	sessionId: string;
	abortCurrentTurn: (() => void) | undefined;
	setAbortCurrentTurn(fn: (() => void) | undefined): void;
	/** Update the LLMOrgan AbortController for the current turn. */
	setLLMController(ctrl: AbortController | undefined): void;
}

/**
 * Handle Ctrl+C \x03.
 * Idle: dispose + stop. Mid-turn: cancel the turn.
 */
export function handleCtrlC(ctx: TuiHandlerContext): void {
	if (ctx.abortCurrentTurn) {
		ctx.abortCurrentTurn();
		ctx.setAbortCurrentTurn(undefined);
		ctx.setLLMController(undefined);
		appendNotice(ctx.chat, "(interrupted)");
		ctx.tui.requestRender(true);
	} else {
		ctx.dispose();
		ctx.tui.stop();
	}
}

/**
 * Handle a slash command string (e.g. "/exit", "/help").
 * Returns true if the command was recognised, false otherwise.
 */
export function handleSlashCommand(text: string, ctx: TuiHandlerContext): boolean {
	const cmd = text.split(" ")[0].toLowerCase();
	switch (cmd) {
		case "/exit":
			ctx.dispose();
			ctx.tui.stop();
			return true;
		case "/new":
			ctx.dialog.clearHistory();
			while (ctx.chat.children.length > 0) {
				ctx.chat.removeChild(ctx.chat.children[0]);
			}
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
// Minimal no-color themes
// ---------------------------------------------------------------------------

const id = (s: string) => s;

const MARKDOWN_THEME: MarkdownTheme = {
	heading: (s) => `\x1b[1m${s}\x1b[0m`, // bold
	link: id,
	linkUrl: id,
	code: (s) => `\x1b[2m${s}\x1b[0m`, // dim
	codeBlock: id,
	codeBlockBorder: id,
	quote: id,
	quoteBorder: id,
	hr: id,
	listBullet: id,
	bold: (s) => `\x1b[1m${s}\x1b[0m`,
	italic: (s) => `\x1b[3m${s}\x1b[0m`,
	strikethrough: id,
	underline: (s) => `\x1b[4m${s}\x1b[0m`,
};

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

function appendUserMsg(chat: Container, text: string): void {
	chat.addChild(new Text(`\x1b[2m> ${text}\x1b[0m`, 1, 0));
}

function appendAgentMsg(chat: Container, text: string): void {
	chat.addChild(new Spacer(1));
	try {
		chat.addChild(new Markdown(text, 1, 0, MARKDOWN_THEME));
	} catch {
		chat.addChild(new Text(text, 1, 0));
	}
	chat.addChild(new Spacer(1));
}

function appendNotice(chat: Container, text: string): void {
	chat.addChild(new Text(`\x1b[2m${text}\x1b[0m`, 1, 0));
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

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

export async function runTuiMode(
	dialog: DialogOrgan,
	opts: InteractiveOptions & { sessionId: string },
	dispose: () => void,
	setLLMAbortController: (ctrl: AbortController | undefined) => void = () => {},
): Promise<void> {
	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal);

	// Header
	const headerText = `Alef  ·  ${opts.modelId}  ·  session:${opts.sessionId}`;
	tui.addChild(new Text(`\x1b[1m${headerText}\x1b[0m`, 1, 0));
	tui.addChild(new Spacer(1));

	// Chat container
	const chat = new Container();
	tui.addChild(chat);

	// Loader (added/removed dynamically while agent runs)
	const loader = new Loader(tui, id, id, "● Thinking…");

	// Hint
	const hint = new Text("\x1b[2m/exit  /new  /resume  /help\x1b[0m", 1, 0);
	tui.addChild(hint);

	// Input
	const input = new Input();
	tui.addChild(input);

	// ── Ctrl+C + slash command handlers ──────────────────────────────────────
	let abortCurrentTurn: (() => void) | undefined;

	const ctx = (): TuiHandlerContext => ({
		chat,
		tui,
		hint,
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

	tui.addInputListener((data) => {
		if (data === "\x03") handleCtrlC(ctx());
		return undefined;
	});

	// ── Input submit handler ──────────────────────────────────────────────────
	// eslint-disable-next-line @typescript-eslint/no-misused-promises -- TUI onSubmit callback is fire-and-forget by design
	input.onSubmit = async (rawText: string) => {
		const text = rawText.trim();
		if (!text) return;

		if (text.startsWith("/")) {
			handleSlashCommand(text, ctx());
			return;
		}

		// User message → agent turn
		input.setValue("");
		appendUserMsg(chat, text);

		tui.removeChild(hint);
		tui.addChild(loader);
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
				appendAgentMsg(chat, reply);
			}
		} catch (e) {
			if (!aborted) appendNotice(chat, `[error] ${formatError(e)}`);
		} finally {
			abortCurrentTurn = undefined;
			setLLMAbortController(undefined);
			tui.removeChild(loader);
			tui.addChild(hint);
			tui.requestRender(true);
		}
	};

	// ── Start ─────────────────────────────────────────────────────────────────
	tui.start();
	tui.setFocus(input);
	tui.requestRender();

	// Block until stopped
	await new Promise<void>((resolve) => {
		const origStop = tui.stop.bind(tui);
		tui.stop = () => {
			origStop();
			resolve();
		};
	});
}
