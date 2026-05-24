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

export class ModalInputHandler {
	private mode: ModalMode = "insert";
	private pendingD = false; // tracks first 'd' in 'dd'
	private readonly onModeChange: (mode: ModalMode) => void;

	constructor(
		private readonly editor: Editor,
		onModeChange: (mode: ModalMode) => void,
	) {
		this.onModeChange = onModeChange;
	}

	getMode(): ModalMode {
		return this.mode;
	}

	private setMode(m: ModalMode): void {
		this.mode = m;
		this.pendingD = false;
		this.onModeChange(m);
	}

	/**
	 * Input listener for tui.addInputListener().
	 * Returns {consume: true} when the key was handled in normal mode.
	 * Returns undefined to let the editor handle it in insert mode.
	 */
	readonly handle = (data: string): { consume?: boolean } | undefined => {
		// Escape always enters normal mode (from insert or resets pending state).
		if (data === "\x1b") {
			if (this.mode === "insert") {
				this.setMode("normal");
				return { consume: true };
			}
			// Already normal — cancel any pending chord.
			this.pendingD = false;
			return { consume: true };
		}

		if (this.mode === "insert") {
			// Passthrough — let editor handle everything.
			return undefined;
		}

		// ── NORMAL MODE ─────────────────────────────────────────────────────

		// Pending 'd' chord: second 'd' = delete line.
		if (this.pendingD) {
			this.pendingD = false;
			if (data === "d") {
				this.editor.handleInput(SEQ.lineStart);
				this.editor.handleInput(SEQ.deleteToLineEnd);
				// Also remove the newline to collapse the line.
				this.editor.handleInput(SEQ.deleteCharForward);
				return { consume: true };
			}
			// Unrecognised chord — fall through to check for other commands.
		}

		switch (data) {
			// ── Motion ──────────────────────────────────────────────────────
			case "h":
				this.editor.handleInput(SEQ.left);
				return { consume: true };
			case "l":
				this.editor.handleInput(SEQ.right);
				return { consume: true };
			case "j":
				this.editor.handleInput(SEQ.down);
				return { consume: true };
			case "k":
				this.editor.handleInput(SEQ.up);
				return { consume: true };
			case "w":
				this.editor.handleInput(SEQ.wordRight);
				return { consume: true };
			case "b":
				this.editor.handleInput(SEQ.wordLeft);
				return { consume: true };
			case "0":
				this.editor.handleInput(SEQ.lineStart);
				return { consume: true };
			case "$":
				this.editor.handleInput(SEQ.lineEnd);
				return { consume: true };

			// ── Editing ─────────────────────────────────────────────────────
			case "x":
				this.editor.handleInput(SEQ.deleteCharForward);
				return { consume: true };
			case "X":
				this.editor.handleInput("\x08"); // backspace
				return { consume: true };
			case "D":
				this.editor.handleInput(SEQ.deleteToLineEnd);
				return { consume: true };
			case "d":
				this.pendingD = true;
				return { consume: true };

			// ── Enter insert mode ────────────────────────────────────────────
			case "i":
				this.setMode("insert");
				return { consume: true };
			case "a":
				this.editor.handleInput(SEQ.right); // cursor one right before insert
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
				this.editor.handleInput("\n"); // new line below
				this.setMode("insert");
				return { consume: true };
			case "O":
				this.editor.handleInput(SEQ.lineStart);
				this.editor.handleInput("\n");
				this.editor.handleInput(SEQ.up);
				this.setMode("insert");
				return { consume: true };

			// ── Undo ────────────────────────────────────────────────────────
			case "u":
				this.editor.handleInput("\x1f"); // ctrl+- (undo)
				return { consume: true };

			default:
				return { consume: true }; // consume unknown keys in normal mode
		}
	};
}
