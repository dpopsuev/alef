/**
 * AutocompleteProvider that surfaces conversation history as ghost-text
 * suggestions (TSK-212).
 *
 * When the user starts typing, getSuggestions() returns history entries
 * that start with the current line. The best match (most recent first) is
 * shown as ghost text by the editor's existing autocomplete machinery.
 *
 * Apply: replaces the current line with the full history entry.
 */

import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@dpopsuev/alef-tui";

export class HistoryAutocompleteProvider implements AutocompleteProvider {
	/**
	 * History entries, newest first.
	 * addEntry() is called by the runner after each user submit.
	 */
	private entries: string[] = [];

	getEntries(): readonly string[] {
		return this.entries;
	}

	addEntry(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		// Deduplicate: remove existing occurrence so newest is first
		const idx = this.entries.indexOf(trimmed);
		if (idx >= 0) this.entries.splice(idx, 1);
		this.entries.unshift(trimmed);
		// Cap at 500 entries
		if (this.entries.length > 500) this.entries.pop();
	}

	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		_options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const currentLine = lines[cursorLine] ?? "";
		const prefix = currentLine.slice(0, cursorCol);

		// Only suggest on single-line input; not if prefix is empty (too noisy).
		if (!prefix || lines.length > 1) return Promise.resolve(null);

		const matches = this.entries.filter((e) => e !== prefix && e.startsWith(prefix));
		if (matches.length === 0) return Promise.resolve(null);

		const items: AutocompleteItem[] = matches.map((m) => ({
			label: m,
			value: m,
			description: "history",
		}));

		return Promise.resolve({ items, prefix });
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		_cursorCol: number,
		item: AutocompleteItem,
		_prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const newLines = [...lines];
		newLines[cursorLine] = item.value;
		return {
			lines: newLines,
			cursorLine,
			cursorCol: item.value.length,
		};
	}
}
