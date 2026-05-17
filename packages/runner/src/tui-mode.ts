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

	// ── Ctrl+C handler ────────────────────────────────────────────────────────
	let abortCurrentTurn: (() => void) | undefined;

	tui.addInputListener((data) => {
		if (data === "\x03") {
			// Ctrl+C
			if (abortCurrentTurn) {
				abortCurrentTurn();
				abortCurrentTurn = undefined;
				appendNotice(chat, "(interrupted)");
				tui.requestRender(true);
			} else {
				dispose();
				tui.stop();
			}
		}
		return undefined;
	});

	// ── Input submit handler ──────────────────────────────────────────────────
	input.onSubmit = async (rawText: string) => {
		const text = rawText.trim();
		if (!text) return;

		// Slash commands
		if (text.startsWith("/")) {
			const cmd = text.split(" ")[0].toLowerCase();
			switch (cmd) {
				case "/exit":
					dispose();
					tui.stop();
					return;
				case "/new":
					dialog.clearHistory();
					// Clear chat
					while (chat.children.length > 0) {
						chat.removeChild(chat.children[0]);
					}
					appendNotice(chat, "(conversation cleared)");
					tui.requestRender(true);
					return;
				case "/resume":
					appendNotice(chat, `session: ${opts.sessionId}`);
					tui.requestRender(true);
					return;
				case "/help":
					appendNotice(chat, helpText());
					tui.requestRender(true);
					return;
				default:
					appendNotice(chat, `Unknown command: ${cmd}. Type /help for list.`);
					tui.requestRender(true);
					return;
			}
		}

		// User message → agent turn
		input.setValue("");
		appendUserMsg(chat, text);

		tui.removeChild(hint);
		tui.addChild(loader);
		tui.requestRender(true);

		let aborted = false;
		abortCurrentTurn = () => {
			aborted = true;
		};

		try {
			const reply = await dialog.send(text, "human", 300_000);
			if (!aborted) {
				appendAgentMsg(chat, reply);
			}
		} catch (e) {
			appendNotice(chat, `[error] ${formatError(e)}`);
		} finally {
			abortCurrentTurn = undefined;
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
