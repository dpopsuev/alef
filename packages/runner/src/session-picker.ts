/**
 * TUI session picker — shown at startup when sessions exist and --resume is not set.
 *
 * Returns the session ID to resume, or undefined to start a new session.
 * Press Enter to select, Escape/q to start new.
 */

import { ProcessTerminal, type SelectItem, SelectList, Text, TUI } from "@dpopsuev/alef-tui";
import { bold, color, getTheme } from "./theme.js";

export async function pickSession(sessions: Array<{ id: string; mtime: Date }>): Promise<string | undefined> {
	if (sessions.length === 0) return undefined;

	const t = getTheme();

	const items: SelectItem[] = [
		{ value: "__new__", label: "New session", description: "Start fresh" },
		...sessions.slice(0, 20).map((s) => ({
			value: s.id,
			label: s.id,
			description: s.mtime.toISOString().replace("T", " ").slice(0, 16),
		})),
	];

	const theme = {
		selectedPrefix: (s: string) => color(s, t.accentFg),
		selectedText: (s: string) => bold(s),
		description: (s: string) => color(s, t.dimFg),
		scrollInfo: (s: string) => color(s, t.dimFg),
		noMatch: (s: string) => color(s, t.dimFg),
	};

	return new Promise<string | undefined>((resolve) => {
		const terminal = new ProcessTerminal();
		const tui = new TUI(terminal);

		tui.addChild(new Text(color("  Sessions — ↑↓ navigate, Enter select, Esc new", t.dimFg), 0, 0));
		tui.addChild(new Text("", 0, 0));

		const list = new SelectList(items, 10, theme);

		list.onSelect = (item) => {
			tui.stop();
			resolve(item.value === "__new__" ? undefined : item.value);
		};

		list.onCancel = () => {
			tui.stop();
			resolve(undefined);
		};

		tui.addChild(list);
		tui.onRawInput = (data) => {
			list.handleInput(data);
			return true;
		};

		tui.start();
		tui.setFocus(list);
		tui.requestRender();
	});
}
