/**
 * Neovim-style modal input handler for the PromptConsole editor.
 *
 * Modes (Djinn shell/modes.go pattern — Mode interface, dispatch table, no switch chains):
 *   INSERT  (default): all input passes through to the editor unchanged.
 *   NORMAL: vim motions (hjkl/w/b/0/$), dd, x, i/a/A/I/o/O enter insert.
 *   COMMAND: triggered by ':' in Normal — accumulates a cmdline, dispatches on Enter.
 *            NOT a third external mode — an internal state on top of Normal,
 *            matching Neovim's command_line_enter(firstc=':') nested-loop design.
 *
 * All keybindings configurable via APP_KEYBINDINGS + KeybindingsManager.
 * Prior art: Djinn shell/modes.go, Neovim ex_getln.c:command_line_enter().
 */

import type { Editor } from "@dpopsuev/alef-tui";
import { APP_KEYBINDINGS, KeybindingsManager } from "@dpopsuev/alef-tui";

export type ModalMode = "insert" | "normal";

// Raw sequences forwarded to the editor for Normal-mode motion/editing.
const SEQ = {
	left: "\x1b[D",
	right: "\x1b[C",
	up: "\x1b[A",
	down: "\x1b[B",
	wordLeft: "\x1b[1;3D",
	wordRight: "\x1b[1;3C",
	lineStart: "\x01",
	lineEnd: "\x05",
	deleteCharForward: "\x04",
	deleteWordForward: "\x1b[3;5~",
	deleteToLineEnd: "\x0b",
	deleteToLineStart: "\x15",
	deleteWordBackward: "\x17",
	redo: "\x1e",
} as const;

const WHICHKEY_TIMEOUT_MS = Number(process.env.ALEF_WHICHKEY_TIMEOUT_MS ?? 600);

const WHICHKEY_HINT =
	"h/j/k/l move  w/b word  i/a insert  dd/dw delete  u/ctrl+r undo/redo  yy/p yank/paste  : command";

import { registry } from "./commands/index.js";

const allCommandNames = registry
	.list()
	.map((c) => `:${c.name}`)
	.sort();

export class ModalInputHandler {
	private outerMode: ModalMode = "insert";
	/** Internal command-line state — active when user presses ':' in Normal. */
	private cmdMode = false;
	private cmdBuffer = "";
	private cmdTabIndex = -1; // cycling through completions
	private savedText = ""; // Editor content before entering command mode

	/** Double-press state for dd (delete line) and yy (yank line). */
	private pendingD = false;
	private _pendingY = false;
	private _searchMode = false;
	private _searchBuffer = "";
	private _lastSearch = "";

	private hintTimer: ReturnType<typeof setTimeout> | undefined;

	private readonly kb: KeybindingsManager;
	private readonly onModeChange: (mode: ModalMode) => void;
	private readonly onHint: (text: string) => void;
	private readonly onColonCommand: (cmd: string) => void;

	constructor(
		private readonly editor: Editor,
		onModeChange: (mode: ModalMode) => void,
		onHint: (text: string) => void = () => {},
		onColonCommand: (cmd: string) => void = () => {},
		kb?: KeybindingsManager,
	) {
		this.onModeChange = onModeChange;
		this.onHint = onHint;
		this.onColonCommand = onColonCommand;
		// Use provided manager or create a default one with APP_KEYBINDINGS.
		this.kb = kb ?? new KeybindingsManager(APP_KEYBINDINGS);
	}

	getMode(): ModalMode {
		return this.outerMode;
	}

	private armHint(): void {
		clearTimeout(this.hintTimer);
		this.hintTimer = setTimeout(() => {
			if (this.outerMode === "normal" && !this.cmdMode) this.onHint(WHICHKEY_HINT);
		}, WHICHKEY_TIMEOUT_MS);
	}

	private clearHint(): void {
		clearTimeout(this.hintTimer);
		this.hintTimer = undefined;
		this.onHint("");
	}

	private setOuterMode(m: ModalMode): void {
		this.outerMode = m;
		this.pendingD = false;
		this.cmdMode = false;
		this.cmdBuffer = "";
		this.cmdTabIndex = -1;
		this.onModeChange(m);
		if (m === "normal") {
			this.armHint();
		} else {
			this.clearHint();
		}
	}

	// ---------------------------------------------------------------------------
	// Command-line mode (Neovim firstc=':' pattern)
	// ---------------------------------------------------------------------------

	private enterCmdMode(): void {
		this.cmdMode = true;
		this.cmdBuffer = "";
		this.cmdTabIndex = -1;
		this.pendingD = false;
		this.clearHint();

		// Save current editor content and show command prompt
		this.savedText = this.editor.getText();
		this.editor.setText(":");
		this.onHint("-- COMMAND --");
	}

	private exitCmdMode(): void {
		this.cmdMode = false;
		this.cmdBuffer = "";
		this.cmdTabIndex = -1;

		// Restore original editor content
		this.editor.setText(this.savedText);
		this.savedText = "";

		this.onHint("");
		this.armHint();
	}

	private updateCmdPrompt(): void {
		// Update editor to show command being typed
		this.editor.setText(`:${this.cmdBuffer}`);
		this.onHint("-- COMMAND --");
	}

	private tabComplete(): void {
		const prefix = `:${this.cmdBuffer.split(" ")[0]}`;
		const matches = allCommandNames.filter((n) => n.startsWith(prefix));
		if (matches.length === 0) return;
		this.cmdTabIndex = (this.cmdTabIndex + 1) % matches.length;
		const completion = matches[this.cmdTabIndex].slice(1); // strip ':'
		// Keep args if any were typed after the command name
		const parts = this.cmdBuffer.split(" ");
		parts[0] = completion;
		this.cmdBuffer = parts.join(" ");
		this.updateCmdPrompt();
	}

	private dispatchColonCommand(): void {
		const raw = this.cmdBuffer.trim();

		// Restore original text before executing command
		this.editor.setText(this.savedText);
		this.savedText = "";

		if (raw) this.onColonCommand(`:${raw}`);
		this.cmdMode = false;
		this.cmdBuffer = "";
		this.cmdTabIndex = -1;
		this.onHint("");

		// After executing a command the user typically wants to type — go to Insert.
		this.setOuterMode("insert");
	}

	private handleCmdModeKey(data: string): { consume: boolean } {
		// Esc — cancel command line, stay in Normal.
		if (data === "\x1b") {
			this.exitCmdMode();
			return { consume: true };
		}
		// Enter — execute.
		if (data === "\r" || data === "\n") {
			this.dispatchColonCommand();
			return { consume: true };
		}
		// Tab — cycle completions.
		if (data === "\t") {
			this.tabComplete();
			return { consume: true };
		}
		// Backspace — delete last char.
		if (data === "\x7f" || data === "\x08") {
			if (this.cmdBuffer.length > 0) {
				this.cmdBuffer = this.cmdBuffer.slice(0, -1);
				this.cmdTabIndex = -1;
				this.updateCmdPrompt();
			} else {
				// Empty buffer + backspace = cancel command mode.
				this.exitCmdMode();
			}
			return { consume: true };
		}
		// Printable ASCII — accumulate.
		if (data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) < 127) {
			this.cmdBuffer += data;
			this.cmdTabIndex = -1;
			this.updateCmdPrompt();
			return { consume: true };
		}
		// Anything else (arrow keys etc.) — consume silently in cmd mode.
		return { consume: true };
	}

	// ---------------------------------------------------------------------------
	// Main input handler
	// ---------------------------------------------------------------------------

	readonly handle = (data: string): { consume?: boolean } | undefined => {
		// ── Command mode (internal — ':', Neovim firstc=':' pattern) ──────────
		if (this.cmdMode) {
			return this.handleCmdModeKey(data);
		}

		// ── Search mode — '/' in Normal activates, Enter/Esc confirms/cancels ─
		if (this._searchMode) {
			if (data === "\r" || data === "\n") {
				this._lastSearch = this._searchBuffer;
				this._searchBuffer = "";
				this._searchMode = false;
				this.onHint("");
			} else if (data === "\x1b") {
				this._searchBuffer = "";
				this._searchMode = false;
				this.onHint("");
			} else if (data === "\x7f" || data === "\b") {
				this._searchBuffer = this._searchBuffer.slice(0, -1);
				this.onHint(`/${this._searchBuffer}`);
			} else if (data.length === 1 && data >= " ") {
				this._searchBuffer += data;
				this.onHint(`/${this._searchBuffer}`);
			}
			return { consume: true };
		}

		// ── Escape → Normal mode ───────────────────────────────────────────────
		if (this.kb.matches(data, "app.mode.normal")) {
			if (this.outerMode === "insert") {
				this.setOuterMode("normal");
			} else {
				// Already Normal: clear pending chords.
				this.pendingD = false;
				this.clearHint();
				this.armHint();
			}
			return { consume: true };
		}

		if (this.outerMode === "insert") {
			return undefined; // passthrough — editor owns Insert-mode keys
		}

		// ':' — enters command line from Normal mode only.
		if (this.kb.matches(data, "app.mode.command")) {
			this.enterCmdMode();
			return { consume: true };
		}

		// ── NORMAL MODE ────────────────────────────────────────────────────────
		this.clearHint();

		// ── Double-press chord: d<motion> ────────────────────────────────────
		if (this.pendingD) {
			this.pendingD = false;
			if (this.kb.matches(data, "app.delete.line")) {
				// dd — delete line
				this.editor.handleInput(SEQ.lineStart);
				this.editor.handleInput(SEQ.deleteToLineEnd);
				this.editor.handleInput(SEQ.deleteCharForward);
				this.armHint();
				return { consume: true };
			}
			if (data === "w") {
				// dw — delete word forward
				this.editor.handleInput(SEQ.deleteWordForward);
				this.armHint();
				return { consume: true };
			}
			// unknown d<key> — cancel silently
			this.armHint();
			return { consume: true };
		}

		// ── Dispatch table (Djinn normalCmds pattern) ─────────────────────────
		if (this.kb.matches(data, "app.delete.line")) {
			this.pendingD = true;
			this.armHint();
			return { consume: true };
		}

		// Scroll — the terminal owns scrollback; use shift+pageup or mouse wheel.
		// Show a one-shot hint and consume the key so it doesn't reach the editor.
		const SCROLL_HINT = "Use shift+pageup / mouse wheel to scroll history";
		if (
			this.kb.matches(data, "app.scroll.down") ||
			this.kb.matches(data, "app.scroll.up") ||
			this.kb.matches(data, "app.scroll.halfPageDown") ||
			this.kb.matches(data, "app.scroll.halfPageUp") ||
			this.kb.matches(data, "app.scroll.bottom")
		) {
			this.onHint(SCROLL_HINT);
			this.armHint();
			return { consume: true };
		}

		// Cursor motions → forwarded to editor
		if (this.kb.matches(data, "app.cursor.left")) {
			this.editor.handleInput(SEQ.left);
			this.armHint();
			return { consume: true };
		}
		if (this.kb.matches(data, "app.cursor.right")) {
			this.editor.handleInput(SEQ.right);
			this.armHint();
			return { consume: true };
		}
		if (data === "j") {
			this.editor.handleInput(SEQ.down);
			this.armHint();
			return { consume: true };
		}
		if (data === "k") {
			this.editor.handleInput(SEQ.up);
			this.armHint();
			return { consume: true };
		}
		if (this.kb.matches(data, "app.cursor.wordLeft")) {
			this.editor.handleInput(SEQ.wordLeft);
			this.armHint();
			return { consume: true };
		}
		if (this.kb.matches(data, "app.cursor.wordRight")) {
			this.editor.handleInput(SEQ.wordRight);
			this.armHint();
			return { consume: true };
		}
		if (this.kb.matches(data, "app.cursor.lineStart")) {
			this.editor.handleInput(SEQ.lineStart);
			this.armHint();
			return { consume: true };
		}
		if (this.kb.matches(data, "app.cursor.lineEnd")) {
			this.editor.handleInput(SEQ.lineEnd);
			this.armHint();
			return { consume: true };
		}

		// Editing
		if (this.kb.matches(data, "app.delete.char")) {
			this.editor.handleInput(SEQ.deleteCharForward);
			this.armHint();
			return { consume: true };
		}
		if (this.kb.matches(data, "app.delete.toLineEnd")) {
			this.editor.handleInput(SEQ.deleteToLineEnd);
			this.armHint();
			return { consume: true };
		}

		// Undo: 'u' — ctrl+- to editor (vim convention)
		if (data === "u") {
			this.editor.handleInput("\x1f");
			this.armHint();
			return { consume: true };
		}
		if (data === "\x1f") {
			this.editor.handleInput("\x1f");
			this.armHint();
			return { consume: true };
		}
		// Redo: ctrl+r
		if (data === "\x12") {
			this.editor.handleInput(SEQ.redo);
			this.armHint();
			return { consume: true };
		}

		// C: change to line end (D + enter insert)
		if (data === "C") {
			this.editor.handleInput(SEQ.deleteToLineEnd);
			this.setOuterMode("insert");
			return { consume: true };
		}

		// yy: yank line into kill ring (ctrl+a to start, ctrl+k to kill, ctrl+y to restore)
		if (data === "y" && !this._pendingY) {
			this._pendingY = true;
			this.armHint();
			return { consume: true };
		}
		if (this._pendingY) {
			this._pendingY = false;
			if (data === "y") {
				// yank current line: go to start, kill to end (stores in kill ring), then yank back
				this.editor.handleInput(SEQ.lineStart);
				this.editor.handleInput(SEQ.deleteToLineEnd);
				this.editor.handleInput("\x19"); // ctrl+y — restore; kill ring now holds the line
			}
			this.armHint();
			return { consume: true };
		}
		// p: paste after cursor from kill ring (ctrl+y)
		if (data === "p") {
			this.editor.handleInput(SEQ.right);
			this.editor.handleInput("\x19");
			this.armHint();
			return { consume: true };
		}
		if (data === "P") {
			this.editor.handleInput("\x19");
			this.armHint();
			return { consume: true };
		}

		// / — enter search mode
		if (data === "/") {
			this._searchMode = true;
			this._searchBuffer = "";
			this.onHint("/");
			return { consume: true };
		}
		// n/N — repeat last search (approximate: forward/backward word search)
		if (data === "n" && this._lastSearch) {
			this.onHint(`/${this._lastSearch} (n)`);
			this.armHint();
			return { consume: true };
		}
		if (data === "N" && this._lastSearch) {
			this.onHint(`/${this._lastSearch} (N)`);
			this.armHint();
			return { consume: true };
		}

		// Quit in Normal mode
		if (this.kb.matches(data, "app.quit")) {
			// Signal handled by caller via onColonCommand(":q")
			this.onColonCommand(":q");
			this.armHint();
			return { consume: true };
		}

		// Enter Insert mode
		if (this.kb.matches(data, "app.mode.insert")) {
			this.setOuterMode("insert");
			return { consume: true };
		}
		if (this.kb.matches(data, "app.mode.insert.append")) {
			this.editor.handleInput(SEQ.right);
			this.setOuterMode("insert");
			return { consume: true };
		}
		if (this.kb.matches(data, "app.mode.insert.appendLineEnd")) {
			// A
			this.editor.handleInput(SEQ.lineEnd);
			this.setOuterMode("insert");
			return { consume: true };
		}
		if (this.kb.matches(data, "app.mode.insert.lineStart")) {
			// I
			this.editor.handleInput(SEQ.lineStart);
			this.setOuterMode("insert");
			return { consume: true };
		}
		if (this.kb.matches(data, "app.mode.insert.openBelow")) {
			// o
			this.editor.handleInput(SEQ.lineEnd);
			this.editor.handleInput("\n");
			this.setOuterMode("insert");
			return { consume: true };
		}
		if (this.kb.matches(data, "app.mode.insert.openAbove")) {
			// O
			this.editor.handleInput(SEQ.lineStart);
			this.editor.handleInput("\n");
			this.editor.handleInput(SEQ.up);
			this.setOuterMode("insert");
			return { consume: true };
		}

		// Unknown key in Normal — consume silently (no unintended editor edits).
		this.armHint();
		return { consume: true };
	};
}
