import { type KeyId, matchesKey } from "./keys.js";

/**
 * Global keybinding registry.
 * Downstream packages can add keybindings via declaration merging.
 */
export interface Keybindings {
	// App-level modal keybindings
	"app.mode.normal": true;
	"app.mode.insert": true;
	"app.mode.insert.append": true;
	"app.mode.insert.appendLineEnd": true;
	"app.mode.insert.openBelow": true;
	"app.mode.insert.openAbove": true;
	"app.mode.insert.lineStart": true;
	"app.mode.command": true;
	"app.quit": true;
	"app.scroll.down": true;
	"app.scroll.up": true;
	"app.scroll.halfPageDown": true;
	"app.scroll.halfPageUp": true;
	"app.scroll.bottom": true;
	"app.scroll.top": true;
	"app.cursor.left": true;
	"app.cursor.right": true;
	"app.cursor.wordLeft": true;
	"app.cursor.wordRight": true;
	"app.cursor.lineStart": true;
	"app.cursor.lineEnd": true;
	"app.delete.char": true;
	"app.delete.line": true;
	"app.delete.toLineEnd": true;
	// Editor navigation and editing
	"tui.editor.cursorUp": true;
	"tui.editor.cursorDown": true;
	"tui.editor.cursorLeft": true;
	"tui.editor.cursorRight": true;
	"tui.editor.cursorWordLeft": true;
	"tui.editor.cursorWordRight": true;
	"tui.editor.cursorLineStart": true;
	"tui.editor.cursorLineEnd": true;
	"tui.editor.jumpForward": true;
	"tui.editor.jumpBackward": true;
	"tui.editor.pageUp": true;
	"tui.editor.pageDown": true;
	"tui.editor.deleteCharBackward": true;
	"tui.editor.deleteCharForward": true;
	"tui.editor.deleteWordBackward": true;
	"tui.editor.deleteWordForward": true;
	"tui.editor.deleteToLineStart": true;
	"tui.editor.deleteToLineEnd": true;
	"tui.editor.yank": true;
	"tui.editor.yankPop": true;
	"tui.editor.undo": true;
	// Generic input actions
	"tui.input.newLine": true;
	"tui.input.submit": true;
	"tui.input.tab": true;
	"tui.input.copy": true;
	// Generic selection actions
	"tui.select.up": true;
	"tui.select.down": true;
	"tui.select.pageUp": true;
	"tui.select.pageDown": true;
	"tui.select.confirm": true;
	"tui.select.cancel": true;
}

export type Keybinding = keyof Keybindings;

export interface KeybindingDefinition {
	defaultKeys: KeyId | KeyId[];
	description?: string;
}

export type KeybindingDefinitions = Record<string, KeybindingDefinition>;
export type KeybindingsConfig = Record<string, KeyId | KeyId[] | undefined>;

/** App-level modal keybindings — Normal/Insert/Command mode transitions and Normal-mode actions. */
export const APP_KEYBINDINGS: KeybindingDefinitions = {
	// Mode transitions
	"app.mode.normal": { defaultKeys: "escape", description: "Enter Normal mode" },
	"app.mode.insert": { defaultKeys: "i", description: "Enter Insert mode" },
	"app.mode.insert.append": { defaultKeys: "a", description: "Enter Insert mode after cursor" },
	"app.mode.insert.appendLineEnd": { defaultKeys: "shift+a", description: "Enter Insert mode at end of line" },
	"app.mode.insert.openBelow": { defaultKeys: "o", description: "Open new line below, enter Insert" },
	"app.mode.insert.openAbove": { defaultKeys: "shift+o", description: "Open new line above, enter Insert" },
	"app.mode.insert.lineStart": { defaultKeys: "shift+i", description: "Enter Insert mode at line start" },
	"app.mode.command": { defaultKeys: ":", description: "Open command line (:command)" },
	// Normal-mode actions
	"app.quit": { defaultKeys: "q", description: "Quit (Normal mode)" },
	"app.scroll.down": { defaultKeys: "j", description: "Scroll down" },
	"app.scroll.up": { defaultKeys: "k", description: "Scroll up" },
	"app.scroll.halfPageDown": { defaultKeys: "ctrl+d", description: "Scroll half page down" },
	"app.scroll.halfPageUp": { defaultKeys: "ctrl+u", description: "Scroll half page up" },
	"app.scroll.bottom": { defaultKeys: "shift+g", description: "Scroll to bottom (G)" },
	"app.scroll.top": { defaultKeys: "g", description: "Scroll to top (gg = two presses)" },
	// Normal-mode cursor motions (forwarded to editor)
	"app.cursor.left": { defaultKeys: "h", description: "Cursor left" },
	"app.cursor.right": { defaultKeys: "l", description: "Cursor right" },
	"app.cursor.wordLeft": { defaultKeys: "b", description: "Word left" },
	"app.cursor.wordRight": { defaultKeys: "w", description: "Word right" },
	"app.cursor.lineStart": { defaultKeys: "0", description: "Cursor to line start" },
	"app.cursor.lineEnd": { defaultKeys: "$", description: "Cursor to line end" },
	// Normal-mode editing
	"app.delete.char": { defaultKeys: "x", description: "Delete character under cursor" },
	"app.delete.line": { defaultKeys: "d", description: "Delete line (dd = two presses)" },
	"app.delete.toLineEnd": { defaultKeys: "shift+d", description: "Delete to end of line (D)" },
};

export const TUI_KEYBINDINGS = {
	"tui.editor.cursorUp": { defaultKeys: "up", description: "Move cursor up" },
	"tui.editor.cursorDown": { defaultKeys: "down", description: "Move cursor down" },
	"tui.editor.cursorLeft": {
		defaultKeys: ["left", "ctrl+b"],
		description: "Move cursor left",
	},
	"tui.editor.cursorRight": {
		defaultKeys: ["right", "ctrl+f"],
		description: "Move cursor right",
	},
	"tui.editor.cursorWordLeft": {
		defaultKeys: ["alt+left", "ctrl+left", "alt+b"],
		description: "Move cursor word left",
	},
	"tui.editor.cursorWordRight": {
		defaultKeys: ["alt+right", "ctrl+right", "alt+f"],
		description: "Move cursor word right",
	},
	"tui.editor.cursorLineStart": {
		defaultKeys: ["home", "ctrl+a"],
		description: "Move to line start",
	},
	"tui.editor.cursorLineEnd": {
		defaultKeys: ["end", "ctrl+e"],
		description: "Move to line end",
	},
	"tui.editor.jumpForward": {
		defaultKeys: "ctrl+]",
		description: "Jump forward to character",
	},
	"tui.editor.jumpBackward": {
		defaultKeys: "ctrl+alt+]",
		description: "Jump backward to character",
	},
	"tui.editor.pageUp": { defaultKeys: "pageUp", description: "Page up" },
	"tui.editor.pageDown": { defaultKeys: "pageDown", description: "Page down" },
	"tui.editor.deleteCharBackward": {
		defaultKeys: "backspace",
		description: "Delete character backward",
	},
	"tui.editor.deleteCharForward": {
		defaultKeys: ["delete", "ctrl+d"],
		description: "Delete character forward",
	},
	"tui.editor.deleteWordBackward": {
		defaultKeys: ["ctrl+w", "alt+backspace"],
		description: "Delete word backward",
	},
	"tui.editor.deleteWordForward": {
		defaultKeys: ["alt+d", "alt+delete"],
		description: "Delete word forward",
	},
	"tui.editor.deleteToLineStart": {
		defaultKeys: "ctrl+u",
		description: "Delete to line start",
	},
	"tui.editor.deleteToLineEnd": {
		defaultKeys: "ctrl+k",
		description: "Delete to line end",
	},
	"tui.editor.yank": { defaultKeys: "ctrl+y", description: "Yank" },
	"tui.editor.yankPop": { defaultKeys: "alt+y", description: "Yank pop" },
	"tui.editor.undo": { defaultKeys: "ctrl+-", description: "Undo" },
	"tui.input.newLine": { defaultKeys: "shift+enter", description: "Insert newline" },
	"tui.input.submit": { defaultKeys: "enter", description: "Submit input" },
	"tui.input.tab": { defaultKeys: "tab", description: "Tab / autocomplete" },
	"tui.input.copy": { defaultKeys: "ctrl+c", description: "Copy selection" },
	"tui.select.up": { defaultKeys: ["up", "k"], description: "Move selection up" },
	"tui.select.down": { defaultKeys: ["down", "j"], description: "Move selection down" },
	"tui.select.pageUp": { defaultKeys: "pageUp", description: "Selection page up" },
	"tui.select.pageDown": {
		defaultKeys: "pageDown",
		description: "Selection page down",
	},
	"tui.select.confirm": { defaultKeys: "enter", description: "Confirm selection" },
	"tui.select.cancel": {
		defaultKeys: ["escape", "ctrl+c"],
		description: "Cancel selection",
	},
} as const satisfies KeybindingDefinitions;

export interface KeybindingConflict {
	key: KeyId;
	keybindings: string[];
}

function normalizeKeys(keys: KeyId | KeyId[] | undefined): KeyId[] {
	if (keys === undefined) return [];
	const keyList = Array.isArray(keys) ? keys : [keys];
	const seen = new Set<KeyId>();
	const result: KeyId[] = [];
	for (const key of keyList) {
		if (!seen.has(key)) {
			seen.add(key);
			result.push(key);
		}
	}
	return result;
}

export class KeyMap {
	private definitions: KeybindingDefinitions;
	private userBindings: KeybindingsConfig;
	private keysById = new Map<Keybinding, KeyId[]>();
	private conflicts: KeybindingConflict[] = [];

	constructor(definitions: KeybindingDefinitions, userBindings: KeybindingsConfig = {}) {
		this.definitions = definitions;
		this.userBindings = userBindings;
		this.rebuild();
	}

	private rebuild(): void {
		this.keysById.clear();
		this.conflicts = [];

		const userClaims = new Map<KeyId, Set<Keybinding>>();
		for (const [keybinding, keys] of Object.entries(this.userBindings)) {
			if (!(keybinding in this.definitions)) continue;
			for (const key of normalizeKeys(keys)) {
				const claimants = userClaims.get(key) ?? new Set<Keybinding>();
				claimants.add(keybinding as Keybinding);
				userClaims.set(key, claimants);
			}
		}

		for (const [key, keybindings] of userClaims) {
			if (keybindings.size > 1) {
				this.conflicts.push({ key, keybindings: [...keybindings] });
			}
		}

		for (const [id, definition] of Object.entries(this.definitions)) {
			const userKeys = this.userBindings[id];
			const keys = userKeys === undefined ? normalizeKeys(definition.defaultKeys) : normalizeKeys(userKeys);
			this.keysById.set(id as Keybinding, keys);
		}
	}

	matches(data: string, keybinding: Keybinding): boolean {
		const keys = this.keysById.get(keybinding) ?? [];
		for (const key of keys) {
			if (matchesKey(data, key)) return true;
		}
		return false;
	}

	getKeys(keybinding: Keybinding): KeyId[] {
		return [...(this.keysById.get(keybinding) ?? [])];
	}

	getDefinition(keybinding: Keybinding): KeybindingDefinition {
		return this.definitions[keybinding];
	}

	getConflicts(): KeybindingConflict[] {
		return this.conflicts.map((conflict) => ({ ...conflict, keybindings: [...conflict.keybindings] }));
	}

	setUserBindings(userBindings: KeybindingsConfig): void {
		this.userBindings = userBindings;
		this.rebuild();
	}

	getUserBindings(): KeybindingsConfig {
		return { ...this.userBindings };
	}

	getResolvedBindings(): KeybindingsConfig {
		const resolved: KeybindingsConfig = {};
		for (const id of Object.keys(this.definitions)) {
			const keys = this.keysById.get(id as Keybinding) ?? [];
			resolved[id] = keys.length === 1 ? keys[0]! : [...keys];
		}
		return resolved;
	}
}

let globalKeybindings: KeyMap | null = null;

export function setKeybindings(keybindings: KeyMap): void {
	globalKeybindings = keybindings;
}

export function getKeybindings(): KeyMap {
	if (!globalKeybindings) {
		globalKeybindings = new KeyMap(TUI_KEYBINDINGS);
	}
	return globalKeybindings;
}
