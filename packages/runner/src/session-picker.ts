/**
 * TUI session picker — vi-modal with preview pane.
 *
 * Normal mode: j/k navigate list, h/l switch to preview, g/G top/bottom
 * Insert mode: i or / to start typing filter, Esc back to normal
 * Enter: select session. Esc in normal mode: start fresh.
 */

import { open, readFile, stat } from "node:fs/promises";

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

const TAIL_BYTES = 32_768;

async function readFileTail(path: string, bytes: number): Promise<string> {
	const info = await stat(path);
	if (info.size <= bytes) return readFile(path, "utf-8");
	const fh = await open(path, "r");
	try {
		const buf = Buffer.alloc(bytes);
		await fh.read(buf, 0, bytes, info.size - bytes);
		const raw = buf.toString("utf-8");
		const firstNewline = raw.indexOf("\n");
		return firstNewline >= 0 ? raw.slice(firstNewline + 1) : raw;
	} finally {
		await fh.close();
	}
}

async function readSessionTail(jsonlPath: string, maxLines: number): Promise<string[]> {
	try {
		const raw = await readFileTail(jsonlPath, TAIL_BYTES);
		const lines = raw.split("\n").filter(Boolean);
		const tail: string[] = [];

		for (const line of lines) {
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
				// skip partial/malformed lines
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

		const modeLabel = new Text(
			color("  NORMAL  j/k navigate  h/l preview  i filter  Enter select  Esc new", t.mutedFg),
			0,
			0,
		);
		tui.addChild(modeLabel);
		tui.addChild(new Text("", 0, 0));

		const searchInput = new Input();

		const previewList = new PreviewSelectList({
			items,
			maxVisible: 12,
			theme: listTheme,
			onModeChange: (mode) => {
				if (mode === "insert") {
					modeLabel.setText(color("  INSERT  type to filter  Esc → normal", t.accentFg));
				} else {
					modeLabel.setText(
						color("  NORMAL  j/k navigate  h/l preview  i filter  Enter select  Esc new", t.mutedFg),
					);
				}
			},
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
			if (data === "\x1b" && previewList.mode === "normal") {
				tui.stop();
				resolve(undefined);
				return true;
			}

			const handled = previewList.handleInput(data);
			if (!handled && previewList.mode === "insert") {
				searchInput.handleInput(data);
				previewList.setFilter(searchInput.getValue());
			}
			tui.requestRender();
			return true;
		};

		tui.start();
		tui.requestRender();
	});
}
