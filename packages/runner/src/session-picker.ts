/**
 * TUI session picker — shown at startup when sessions exist and --resume is not set.
 *
 * Type to fuzzy-filter. ↑↓ navigate. Enter select. Esc start fresh.
 * Right pane shows tail preview of the selected session's conversation.
 */

import { readFile } from "node:fs/promises";

import { Input, PreviewSelectList, ProcessTerminal, type SelectItem, Text, TUI } from "@dpopsuev/alef-tui";
import type { StorageRecord } from "./session-store.js";
import { bold, color, getTheme } from "./theme.js";

async function readSessionName(jsonlPath: string): Promise<string | undefined> {
	try {
		const raw = await readFile(jsonlPath, "utf-8");
		const lines = raw.split("\n").filter(Boolean);
		let name: string | undefined;
		for (const line of lines) {
			try {
				const r = JSON.parse(line) as { bus?: string; type?: string; payload?: { name?: string } };
				if (r.bus === "internal" && r.type === "session.name" && typeof r.payload?.name === "string") {
					name = r.payload.name;
				}
			} catch {
				break;
			}
		}
		return name;
	} catch {
		return undefined;
	}
}

async function readFirstUserMessage(jsonlPath: string): Promise<string> {
	try {
		const raw = await readFile(jsonlPath, "utf-8");
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			const record = JSON.parse(line) as StorageRecord;
			if (record.bus === "sense" && record.type === "llm.input") {
				const text = typeof record.payload.text === "string" ? record.payload.text : "";
				if (text) return text.slice(0, 60).replace(/\n/g, " ");
			}
		}
	} catch {
		// unreadable
	}
	return "";
}

async function readSessionTail(jsonlPath: string, maxLines: number): Promise<string[]> {
	try {
		const raw = await readFile(jsonlPath, "utf-8");
		const lines = raw.split("\n").filter(Boolean);
		const tail: string[] = [];

		for (const line of lines.slice(-50)) {
			try {
				const r = JSON.parse(line) as StorageRecord;
				if (r.bus === "sense" && r.type === "llm.input") {
					const text = typeof r.payload.text === "string" ? r.payload.text : "";
					if (text) tail.push(`  ▸ ${text.slice(0, 70).replace(/\n/g, " ")}`);
				} else if (r.bus === "motor" && r.type === "llm.response") {
					const text = typeof r.payload.text === "string" ? r.payload.text : "";
					if (text) tail.push(`  ◂ ${text.slice(0, 70).replace(/\n/g, " ")}`);
				} else if (r.bus === "motor" && !r.type.startsWith("llm.") && !r.type.startsWith("context.")) {
					tail.push(`  ● ${r.type}`);
				}
			} catch {
				// skip
			}
		}

		return tail.slice(-maxLines);
	} catch {
		return ["  (unable to read session)"];
	}
}

export async function pickSession(
	sessions: Array<{ id: string; path: string; mtime: Date }>,
): Promise<string | undefined> {
	if (sessions.length === 0) return undefined;

	const t = getTheme();

	const [names, previews] = await Promise.all([
		Promise.all(sessions.slice(0, 20).map((s) => readSessionName(s.path))),
		Promise.all(sessions.slice(0, 20).map((s) => readFirstUserMessage(s.path))),
	]);

	const sessionPaths = new Map<string, string>();
	const items: SelectItem[] = [
		{ value: "__new__", label: "New session", description: "Start fresh" },
		...sessions.slice(0, 20).map((s, i) => {
			sessionPaths.set(s.id, s.path);
			return {
				value: s.id,
				label: names[i] ?? previews[i] ?? s.id,
				description: s.mtime.toISOString().replace("T", " ").slice(0, 16),
			};
		}),
	];

	const previewCache = new Map<string, string[]>();

	const listTheme = {
		selectedPrefix: (s: string) => color(s, t.accentFg),
		selectedText: (s: string) => bold(s),
		description: (s: string) => color(s, t.mutedFg),
		scrollInfo: (s: string) => color(s, t.mutedFg),
		noMatch: (s: string) => color(s, t.mutedFg),
	};

	return new Promise<string | undefined>((resolve) => {
		const terminal = new ProcessTerminal();
		const tui = new TUI(terminal);

		tui.addChild(new Text(color("  Sessions — type to filter  ↑↓ navigate  Enter select  Esc new", t.mutedFg), 0, 0));
		tui.addChild(new Text("", 0, 0));

		const searchInput = new Input();

		const previewList = new PreviewSelectList({
			items,
			maxVisible: 12,
			theme: listTheme,
			previewFn: (item) => {
				if (!item || item.value === "__new__") return ["  Start a new conversation"];
				const cached = previewCache.get(item.value);
				if (cached) return cached;

				const path = sessionPaths.get(item.value);
				if (!path) return ["  (no session data)"];

				void readSessionTail(path, 12).then((lines) => {
					previewCache.set(item.value, lines);
					tui.requestRender();
				});
				return ["  Loading..."];
			},
		});

		previewList.onSelect = (item) => {
			tui.stop();
			resolve(item.value === "__new__" ? undefined : item.value);
		};

		tui.addChild(searchInput);
		tui.addChild(previewList);

		tui.onRawInput = (data) => {
			if (data === "\x1b") {
				tui.stop();
				resolve(undefined);
				return true;
			}
			if (data === "\x1b[A" || data === "\x1b[B" || data === "\r" || data === "\n") {
				previewList.handleInput(data);
			} else {
				searchInput.handleInput(data);
				previewList.setFilter(searchInput.getValue());
			}
			tui.requestRender();
			return true;
		};

		tui.start();
		tui.setFocus(searchInput);
		tui.requestRender();
	});
}
