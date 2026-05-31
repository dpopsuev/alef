/**
 * TUI session picker — shown at startup when sessions exist and --resume is not set.
 *
 * Type to fuzzy-filter. ↑↓ navigate. Enter select. Esc start fresh.
 */

import { readFile } from "node:fs/promises";
import type { StorageRecord } from "@dpopsuev/alef-spine";
import { Input, ProcessTerminal, type SelectItem, SelectList, Text, TUI } from "@dpopsuev/alef-tui";
import { bold, color, getTheme } from "./theme.js";

async function readFirstUserMessage(jsonlPath: string): Promise<string> {
	try {
		const raw = await readFile(jsonlPath, "utf-8");
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			const record = JSON.parse(line) as StorageRecord;
			if (record.bus === "sense" && record.type === "dialog.message") {
				const text = typeof record.payload.text === "string" ? record.payload.text : "";
				if (text) return text.slice(0, 60).replace(/\n/g, " ");
			}
		}
	} catch {
		// unreadable — fall through
	}
	return "";
}

export async function pickSession(
	sessions: Array<{ id: string; path: string; mtime: Date }>,
): Promise<string | undefined> {
	if (sessions.length === 0) return undefined;

	const t = getTheme();

	const previews = await Promise.all(sessions.slice(0, 20).map((s) => readFirstUserMessage(s.path)));

	const items: SelectItem[] = [
		{ value: "__new__", label: "New session", description: "Start fresh" },
		...sessions.slice(0, 20).map((s, i) => ({
			value: s.id,
			label: previews[i] || s.id,
			description: s.mtime.toISOString().replace("T", " ").slice(0, 16),
		})),
	];

	const listTheme = {
		selectedPrefix: (s: string) => color(s, t.accentFg),
		selectedText: (s: string) => bold(s),
		description: (s: string) => color(s, t.dimFg),
		scrollInfo: (s: string) => color(s, t.dimFg),
		noMatch: (s: string) => color(s, t.dimFg),
	};

	return new Promise<string | undefined>((resolve) => {
		const terminal = new ProcessTerminal();
		const tui = new TUI(terminal);

		tui.addChild(new Text(color("  Sessions — type to filter  ↑↓ navigate  Enter select  Esc new", t.dimFg), 0, 0));
		tui.addChild(new Text("", 0, 0));

		const searchInput = new Input();
		const list = new SelectList(items, 10, listTheme);

		list.onSelect = (item) => {
			tui.stop();
			resolve(item.value === "__new__" ? undefined : item.value);
		};

		tui.addChild(searchInput);
		tui.addChild(list);

		tui.onRawInput = (data) => {
			if (data === "\x1b") {
				tui.stop();
				resolve(undefined);
				return true;
			}
			// ↑↓ and Enter route to the list; everything else filters via searchInput.
			if (data === "\x1b[A" || data === "\x1b[B" || data === "\r" || data === "\n") {
				list.handleInput(data);
			} else {
				searchInput.handleInput(data);
				list.setFilter(searchInput.getValue());
			}
			tui.requestRender(); // ALE-BUG-47 fix — repaint after every keystroke
			return true;
		};

		tui.start();
		tui.setFocus(searchInput);
		tui.requestRender();
	});
}
