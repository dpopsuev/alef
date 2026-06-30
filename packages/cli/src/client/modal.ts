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
 * All keybindings configurable via APP_KEYBINDINGS + KeyMap.
 * Prior art: Djinn shell/modes.go, Neovim ex_getln.c:command_line_enter().
 */

import type { Editor } from "@dpopsuev/alef-tui";
import { APP_KEYBINDINGS, KeyMap, matchesKey } from "@dpopsuev/alef-tui";

/** The two outer modes of the vi-modal input handler. */
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
const ASCII_PRINTABLE_START = 32;
const ASCII_PRINTABLE_END = 127;

const WHICHKEY_HINT =
	"h/j/k/l move  w/b word  i/a insert  dd/dw delete  u/ctrl+r undo/redo  yy/p yank/paste  : command";

import { registry } from "./commands/commands.js";

const allCommandNames = registry
	.list()
	.map((c) => `:${c.name}`)
	.sort();

// ---------------------------------------------------------------------------
// Dispatch table types
// ---------------------------------------------------------------------------

/** Key identifier type accepted by matchesKey (e.g. "escape", "ctrl+r"). */
type KeyIdParam = Parameters<typeof matchesKey>[1];

/** Keybinding action type accepted by KeyMap.matches (e.g. "app.mode.insert"). */
type KbActionParam = Parameters<KeyMap["matches"]>[1];

/** A dispatch entry: literal key matched via matchesKey, plus handler. */
type DispatchEntry = [key: KeyIdParam, handler: (data: string) => { consume: boolean }];

/** A keybinding-action dispatch entry: action matched via kb.matches. */
type KbDispatchEntry = [action: KbActionParam, handler: (data: string) => { consume: boolean }];

const CONSUMED: { consume: boolean } = { consume: true };

/** Neovim-style modal input handler with normal, insert, command, and search modes. */
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

	private readonly kb: KeyMap;
	private readonly onModeChange: (mode: ModalMode) => void;
	private readonly onHint: (text: string) => void;
	private readonly onColonCommand: (cmd: string) => void;

	// ── Dispatch tables ──────────────────────────────────────────────────────
	// Each entry is [keybinding-action | literal-key, handler].
	// Tables are evaluated in order; first match wins.

	/** Search-mode key dispatch (active when '/' is entered in Normal). */
	private readonly searchModeBindings: DispatchEntry[];

	/** Command-mode key dispatch (active when ':' is entered in Normal). */
	private readonly cmdModeBindings: DispatchEntry[];

	/** d<motion> chord — second keypress after 'd'. */
	private readonly dChordBindings: DispatchEntry[];

	/** Normal-mode bindings — keybinding-action entries matched via kb.matches. */
	private readonly normalModeKbBindings: KbDispatchEntry[];

	/** Normal-mode bindings — literal-key entries matched via matchesKey. */
	private readonly normalModeLiteralBindings: DispatchEntry[];

	constructor(
		private readonly editor: Editor,
		onModeChange: (mode: ModalMode) => void,
		onHint: (text: string) => void = () => {},
		onColonCommand: (cmd: string) => void = () => {},
		kb?: KeyMap,
	) {
		this.onModeChange = onModeChange;
		this.onHint = onHint;
		this.onColonCommand = onColonCommand;
		// Use provided manager or create a default one with APP_KEYBINDINGS.
		this.kb = kb ?? new KeyMap(APP_KEYBINDINGS);

		// ── Build dispatch tables ────────────────────────────────────────────
		this.searchModeBindings = this.buildSearchModeBindings();
		this.cmdModeBindings = this.buildCmdModeBindings();
		this.dChordBindings = this.buildDChordBindings();
		this.normalModeKbBindings = this.buildNormalModeKbBindings();
		this.normalModeLiteralBindings = this.buildNormalModeLiteralBindings();
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

	// ---------------------------------------------------------------------------
	// Dispatch table builders
	// ---------------------------------------------------------------------------

	private buildSearchModeBindings(): DispatchEntry[] {
		return [
			[
				"enter",
				() => {
					this._lastSearch = this._searchBuffer;
					this._searchBuffer = "";
					this._searchMode = false;
					this.onHint("");
					return CONSUMED;
				},
			],
			[
				"escape",
				() => {
					this._searchBuffer = "";
					this._searchMode = false;
					this.onHint("");
					return CONSUMED;
				},
			],
			[
				"backspace",
				() => {
					this._searchBuffer = this._searchBuffer.slice(0, -1);
					this.onHint(`/${this._searchBuffer}`);
					return CONSUMED;
				},
			],
		];
	}

	private buildCmdModeBindings(): DispatchEntry[] {
		return [
			[
				"escape",
				() => {
					this.exitCmdMode();
					return CONSUMED;
				},
			],
			[
				"enter",
				() => {
					this.dispatchColonCommand();
					return CONSUMED;
				},
			],
			[
				"tab",
				() => {
					this.tabComplete();
					return CONSUMED;
				},
			],
			[
				"backspace",
				() => {
					if (this.cmdBuffer.length > 0) {
						this.cmdBuffer = this.cmdBuffer.slice(0, -1);
						this.cmdTabIndex = -1;
						this.updateCmdPrompt();
					} else {
						// Empty buffer + backspace = cancel command mode.
						this.exitCmdMode();
					}
					return CONSUMED;
				},
			],
		];
	}

	private buildDChordBindings(): DispatchEntry[] {
		return [
			[
				"d",
				() => {
					// dd — delete line
					this.editor.handleInput(SEQ.lineStart);
					this.editor.handleInput(SEQ.deleteToLineEnd);
					this.editor.handleInput(SEQ.deleteCharForward);
					this.armHint();
					return CONSUMED;
				},
			],
			[
				"w",
				() => {
					// dw — delete word forward
					this.editor.handleInput(SEQ.deleteWordForward);
					this.armHint();
					return CONSUMED;
				},
			],
		];
	}

	private buildNormalModeKbBindings(): KbDispatchEntry[] {
		const SCROLL_HINT = "Use shift+pageup / mouse wheel to scroll history";

		return [
			// d — arm the d-chord (pendingD handled before this table is consulted)
			[
				"app.delete.line",
				() => {
					this.pendingD = true;
					this.armHint();
					return CONSUMED;
				},
			],

			// Scroll — terminal owns scrollback; show hint, consume key.
			[
				"app.scroll.down",
				() => {
					this.onHint(SCROLL_HINT);
					this.armHint();
					return CONSUMED;
				},
			],
			[
				"app.scroll.up",
				() => {
					this.onHint(SCROLL_HINT);
					this.armHint();
					return CONSUMED;
				},
			],
			[
				"app.scroll.halfPageDown",
				() => {
					this.onHint(SCROLL_HINT);
					this.armHint();
					return CONSUMED;
				},
			],
			[
				"app.scroll.halfPageUp",
				() => {
					this.onHint(SCROLL_HINT);
					this.armHint();
					return CONSUMED;
				},
			],
			[
				"app.scroll.bottom",
				() => {
					this.onHint(SCROLL_HINT);
					this.armHint();
					return CONSUMED;
				},
			],

			// Cursor motions → forwarded to editor
			[
				"app.cursor.left",
				() => {
					this.editor.handleInput(SEQ.left);
					this.armHint();
					return CONSUMED;
				},
			],
			[
				"app.cursor.right",
				() => {
					this.editor.handleInput(SEQ.right);
					this.armHint();
					return CONSUMED;
				},
			],
			[
				"app.cursor.wordLeft",
				() => {
					this.editor.handleInput(SEQ.wordLeft);
					this.armHint();
					return CONSUMED;
				},
			],
			[
				"app.cursor.wordRight",
				() => {
					this.editor.handleInput(SEQ.wordRight);
					this.armHint();
					return CONSUMED;
				},
			],
			[
				"app.cursor.lineStart",
				() => {
					this.editor.handleInput(SEQ.lineStart);
					this.armHint();
					return CONSUMED;
				},
			],
			[
				"app.cursor.lineEnd",
				() => {
					this.editor.handleInput(SEQ.lineEnd);
					this.armHint();
					return CONSUMED;
				},
			],

			// Editing
			[
				"app.delete.char",
				() => {
					this.editor.handleInput(SEQ.deleteCharForward);
					this.armHint();
					return CONSUMED;
				},
			],
			[
				"app.delete.toLineEnd",
				() => {
					this.editor.handleInput(SEQ.deleteToLineEnd);
					this.armHint();
					return CONSUMED;
				},
			],

			// Quit
			[
				"app.quit",
				() => {
					this.onColonCommand(":q");
					this.armHint();
					return CONSUMED;
				},
			],

			// Enter Insert mode
			[
				"app.mode.insert",
				() => {
					this.setOuterMode("insert");
					return CONSUMED;
				},
			],
			[
				"app.mode.insert.append",
				() => {
					this.editor.handleInput(SEQ.right);
					this.setOuterMode("insert");
					return CONSUMED;
				},
			],
			[
				"app.mode.insert.appendLineEnd",
				() => {
					this.editor.handleInput(SEQ.lineEnd);
					this.setOuterMode("insert");
					return CONSUMED;
				},
			],
			[
				"app.mode.insert.lineStart",
				() => {
					this.editor.handleInput(SEQ.lineStart);
					this.setOuterMode("insert");
					return CONSUMED;
				},
			],
			[
				"app.mode.insert.openBelow",
				() => {
					this.editor.handleInput(SEQ.lineEnd);
					this.editor.handleInput("\n");
					this.setOuterMode("insert");
					return CONSUMED;
				},
			],
			[
				"app.mode.insert.openAbove",
				() => {
					this.editor.handleInput(SEQ.lineStart);
					this.editor.handleInput("\n");
					this.editor.handleInput(SEQ.up);
					this.setOuterMode("insert");
					return CONSUMED;
				},
			],
		];
	}

	private buildNormalModeLiteralBindings(): DispatchEntry[] {
		return [
			// Undo: u or ctrl+-
			[
				"u",
				() => {
					this.editor.handleInput("\x1f");
					this.armHint();
					return CONSUMED;
				},
			],
			[
				"ctrl+-",
				() => {
					this.editor.handleInput("\x1f");
					this.armHint();
					return CONSUMED;
				},
			],
			// Redo: ctrl+r
			[
				"ctrl+r",
				() => {
					this.editor.handleInput(SEQ.redo);
					this.armHint();
					return CONSUMED;
				},
			],
			// C: change to line end (D + enter insert)
			[
				"shift+c",
				() => {
					this.editor.handleInput(SEQ.deleteToLineEnd);
					this.setOuterMode("insert");
					return CONSUMED;
				},
			],
			// p: paste after cursor from kill ring (ctrl+y)
			[
				"p",
				() => {
					this.editor.handleInput(SEQ.right);
					this.editor.handleInput("\x19");
					this.armHint();
					return CONSUMED;
				},
			],
			// P: paste before cursor from kill ring (ctrl+y)
			[
				"shift+p",
				() => {
					this.editor.handleInput("\x19");
					this.armHint();
					return CONSUMED;
				},
			],
			// / — enter search mode
			[
				"/",
				() => {
					this._searchMode = true;
					this._searchBuffer = "";
					this.onHint("/");
					return CONSUMED;
				},
			],
		];
	}

	// ---------------------------------------------------------------------------
	// Table-driven dispatch helpers
	// ---------------------------------------------------------------------------

	/** Walk a literal-key dispatch table; return first match or undefined. */
	private dispatchLiteral(data: string, table: DispatchEntry[]): { consume: boolean } | undefined {
		for (const [key, handler] of table) {
			if (matchesKey(data, key)) return handler(data);
		}
		return undefined;
	}

	/** Walk a keybinding-action dispatch table; return first match or undefined. */
	private dispatchKb(data: string, table: KbDispatchEntry[]): { consume: boolean } | undefined {
		for (const [action, handler] of table) {
			if (this.kb.matches(data, action)) return handler(data);
		}
		return undefined;
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
			return this.handleSearchModeKey(data);
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
			return CONSUMED;
		}

		if (this.outerMode === "insert") {
			return undefined; // passthrough — editor owns Insert-mode keys
		}

		// ':' — enters command line from Normal mode only.
		if (this.kb.matches(data, "app.mode.command")) {
			this.enterCmdMode();
			return CONSUMED;
		}

		// ── NORMAL MODE ────────────────────────────────────────────────────────
		this.clearHint();

		// ── Double-press chord: d<motion> ────────────────────────────────────
		if (this.pendingD) {
			this.pendingD = false;
			const dResult = this.dispatchLiteral(data, this.dChordBindings);
			if (dResult) return dResult;
			// unknown d<key> — cancel silently
			this.armHint();
			return CONSUMED;
		}

		// ── Double-press chord: y<motion> ────────────────────────────────────
		if (this._pendingY) {
			this._pendingY = false;
			if (matchesKey(data, "y")) {
				// yank current line: go to start, kill to end (stores in kill ring), then yank back
				this.editor.handleInput(SEQ.lineStart);
				this.editor.handleInput(SEQ.deleteToLineEnd);
				this.editor.handleInput("\x19"); // ctrl+y — restore; kill ring now holds the line
			}
			this.armHint();
			return CONSUMED;
		}

		// ── Keybinding-action dispatch (Djinn normalCmds pattern) ────────────
		const kbResult = this.dispatchKb(data, this.normalModeKbBindings);
		if (kbResult) return kbResult;

		// ── Literal-key dispatch ─────────────────────────────────────────────
		const litResult = this.dispatchLiteral(data, this.normalModeLiteralBindings);
		if (litResult) return litResult;

		// ── Stateful literal keys (depend on runtime state) ──────────────────
		// y — arm the yy chord
		if (matchesKey(data, "y")) {
			this._pendingY = true;
			this.armHint();
			return CONSUMED;
		}
		// n/N — repeat last search (only when _lastSearch is non-empty)
		if (matchesKey(data, "n") && this._lastSearch) {
			this.onHint(`/${this._lastSearch} (n)`);
			this.armHint();
			return CONSUMED;
		}
		if (matchesKey(data, "shift+n") && this._lastSearch) {
			this.onHint(`/${this._lastSearch} (N)`);
			this.armHint();
			return CONSUMED;
		}

		// Unknown key in Normal — consume silently (no unintended editor edits).
		this.armHint();
		return CONSUMED;
	};

	// ---------------------------------------------------------------------------
	// Table-driven sub-mode handlers
	// ---------------------------------------------------------------------------

	private handleCmdModeKey(data: string): { consume: boolean } {
		const result = this.dispatchLiteral(data, this.cmdModeBindings);
		if (result) return result;

		// Printable ASCII — accumulate.
		if (
			data.length === 1 &&
			data.charCodeAt(0) >= ASCII_PRINTABLE_START &&
			data.charCodeAt(0) < ASCII_PRINTABLE_END
		) {
			this.cmdBuffer += data;
			this.cmdTabIndex = -1;
			this.updateCmdPrompt();
			return CONSUMED;
		}
		// Anything else (arrow keys etc.) — consume silently in cmd mode.
		return CONSUMED;
	}

	private handleSearchModeKey(data: string): { consume: boolean } {
		const result = this.dispatchLiteral(data, this.searchModeBindings);
		if (result) return result;

		// Printable character — accumulate in search buffer.
		if (data.length === 1 && data >= " ") {
			this._searchBuffer += data;
			this.onHint(`/${this._searchBuffer}`);
		}
		return CONSUMED;
	}
}
