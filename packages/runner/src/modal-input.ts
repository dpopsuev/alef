/**
 * Lightweight Neovim-style modal input handler for the ConsoleZone editor.
 *
 * Modes:
 *   INSERT (default): all input passes through to the editor unchanged.
 *   NORMAL: hjkl/w/b movement, x delete char, dd delete line, i/a/A/I/o/O enter insert.
 *
 * Wired via tui.addInputListener() which intercepts before the focused component.
 * Returns {consume: true} in normal mode to prevent the editor from seeing raw keys.
 */

import type { Editor } from "@dpopsuev/alef-tui";

export type ModalMode = "insert" | "normal";

// Raw sequences forwarded to the editor for normal-mode movement/editing.
// These match the keybindings already registered in tui/src/keybindings.ts.
const SEQ = {
	left: "\x1b[D",
	right: "\x1b[C",
	up: "\x1b[A",
	down: "\x1b[B",
	wordLeft: "\x1b[1;3D", // alt+left
	wordRight: "\x1b[1;3C", // alt+right
	lineStart: "\x01", // ctrl+a
	lineEnd: "\x05", // ctrl+e
	deleteCharForward: "\x04", // ctrl+d
	deleteToLineEnd: "\x0b", // ctrl+k
	deleteToLineStart: "\x15", // ctrl+u
	deleteWordBackward: "\x17", // ctrl+w
} as const;

const WHICHKEY_TIMEOUT_MS = Number(process.env.ALEF_WHICHKEY_TIMEOUT_MS ?? 600);

const WHICHKEY_HINT = "hjkl move  w/b word  i/a insert  dd delete line  u undo  0/$ line start/end";

export class ModalInputHandler {
	private mode: ModalMode = "insert";
	private pendingD = false; // tracks first 'd' in 'dd'
	private hintTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly onModeChange: (mode: ModalMode) => void;
	private readonly onHint: (text: string) => void;

	constructor(
		private readonly editor: Editor,
		onModeChange: (mode: ModalMode) => void,
		/** Called with hint text after idle timeout, or empty string to clear. */
		onHint: (text: string) => void = () => {},
	) {
		this.onModeChange = onModeChange;
		this.onHint = onHint;
	}

	getMode(): ModalMode {
		return this.mode;
	}

	/** Start or restart the which-key idle timer (ALE-TSK-213). */
	private armHint(): void {
		clearTimeout(this.hintTimer);
		this.hintTimer = setTimeout(() => {
			if (this.mode === "normal") this.onHint(WHICHKEY_HINT);
		}, WHICHKEY_TIMEOUT_MS);
	}

	/** Cancel the timer and clear the hint text. */
	private clearHint(): void {
		clearTimeout(this.hintTimer);
		this.hintTimer = undefined;
		this.onHint("");
	}

	private setMode(m: ModalMode): void {
		this.mode = m;
		this.pendingD = false;
		this.onModeChange(m);
		if (m === "normal") {
			this.armHint();
		} else {
			this.clearHint();
		}
	}

	/**
	 * Input listener for tui.addInputListener().
	 * Returns {consume: true} when the key was handled in normal mode.
	 * Returns undefined to let the editor handle it in insert mode.
	 */
	readonly handle = (data: string): { consume?: boolean } | undefined => {
		// Escape: insert → normal, or cancel pending chord in normal.
		if (data === "\x1b") {
			if (this.mode === "insert") {
				this.setMode("normal");
			} else {
				this.pendingD = false;
				this.clearHint();
				this.armHint();
			}
			return { consume: true };
		}

		if (this.mode === "insert") {
			return undefined; // passthrough — let editor handle everything
		}

		// ── NORMAL MODE ──────────────────────────────────────────────────────
		// Clear the hint on any key; re-arm at the end if mode stays normal.
		this.clearHint();

		// Pending 'd' chord: second 'd' = delete entire line.
		if (this.pendingD) {
			this.pendingD = false;
			if (data === "d") {
				this.editor.handleInput(SEQ.lineStart);
				this.editor.handleInput(SEQ.deleteToLineEnd);
				this.editor.handleInput(SEQ.deleteCharForward); // collapse newline
				this.armHint();
				return { consume: true };
			}
			// Unrecognised chord — fall through to handle as standalone key.
		}

		switch (data) {
			// ── Motion ──────────────────────────────────────────────────────
			case "h":
				this.editor.handleInput(SEQ.left);
				break;
			case "l":
				this.editor.handleInput(SEQ.right);
				break;
			case "j":
				this.editor.handleInput(SEQ.down);
				break;
			case "k":
				this.editor.handleInput(SEQ.up);
				break;
			case "w":
				this.editor.handleInput(SEQ.wordRight);
				break;
			case "b":
				this.editor.handleInput(SEQ.wordLeft);
				break;
			case "0":
				this.editor.handleInput(SEQ.lineStart);
				break;
			case "$":
				this.editor.handleInput(SEQ.lineEnd);
				break;

			// ── Editing ─────────────────────────────────────────────────────
			case "x":
				this.editor.handleInput(SEQ.deleteCharForward);
				break;
			case "X":
				this.editor.handleInput("\x08");
				break; // backspace
			case "D":
				this.editor.handleInput(SEQ.deleteToLineEnd);
				break;
			case "d":
				this.pendingD = true;
				break;
			case "u":
				this.editor.handleInput("\x1f");
				break; // ctrl+- = undo

			// ── Enter insert mode ────────────────────────────────────────────
			case "i":
				this.setMode("insert");
				return { consume: true };
			case "a":
				this.editor.handleInput(SEQ.right);
				this.setMode("insert");
				return { consume: true };
			case "A":
				this.editor.handleInput(SEQ.lineEnd);
				this.setMode("insert");
				return { consume: true };
			case "I":
				this.editor.handleInput(SEQ.lineStart);
				this.setMode("insert");
				return { consume: true };
			case "o":
				this.editor.handleInput(SEQ.lineEnd);
				this.editor.handleInput("\n");
				this.setMode("insert");
				return { consume: true };
			case "O":
				this.editor.handleInput(SEQ.lineStart);
				this.editor.handleInput("\n");
				this.editor.handleInput(SEQ.up);
				this.setMode("insert");
				return { consume: true };

			default:
				break; // unknown key: consumed silently
		}

		// Re-arm which-key hint after any motion/edit that stays in normal mode.
		this.armHint();
		return { consume: true };
	};
}
