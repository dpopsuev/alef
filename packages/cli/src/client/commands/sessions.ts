const SESSION_PICKER_MAX_VISIBLE = 12;
const SESSION_PREVIEW_LINES = 12;

/**
 * TUI session picker — vi-modal with preview pane, cwd/all scope, content search.
 */

import type { SessionListEntry, SessionPreviewProvider, SessionStoreFactory } from "@dpopsuev/alef-storage";
import type { SelectItem } from "@dpopsuev/alef-tui";
import { runPicker } from "./picker.js";

type SessionScope = "current" | "all";

/**
 *
 */
function shortenCwd(cwd: string | undefined): string {
	if (!cwd) return "";
	const home = process.env.HOME;
	const display = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
	const parts = display.split("/").filter(Boolean);
	if (parts.length <= 2) return display;
	return parts.slice(-2).join("/");
}

/**
 *
 */
function formatMtime(mtime: Date): string {
	return mtime.toISOString().replace("T", " ").slice(0, 16);
}

/**
 *
 */
function toItems(entries: SessionListEntry[], scope: SessionScope): SelectItem[] {
	return [
		{ value: "__new__", label: "New session", description: "Start fresh" },
		...entries.map((s) => {
			const tags = s.tags?.length ? ` · ${s.tags.join(" ")}` : "";
			const cwdPart = scope === "all" && s.cwd ? `${shortenCwd(s.cwd)} · ` : "";
			return {
				value: s.id,
				label: s.name ?? s.id,
				description: `${cwdPart}${formatMtime(s.mtime)}${tags}`,
				searchText: [s.name, s.id, ...(s.tags ?? []), s.searchBlob ?? "", s.cwd ?? ""].filter(Boolean).join(" "),
			};
		}),
	];
}

/** Show a vi-modal session picker with preview and return the chosen session ID. */
export async function pickSession(
	cwd: string,
	sessions: SessionStoreFactory,
	preview?: SessionPreviewProvider,
): Promise<string | undefined> {
	let scope: SessionScope = "current";
	let currentEntries = await sessions.list(cwd);
	let allEntries: SessionListEntry[] | undefined;

	if (currentEntries.length === 0) {
		allEntries = await sessions.listAll();
		if (allEntries.length === 0) return undefined;
		scope = "all";
	}

	const entriesFor = async (next: SessionScope): Promise<SessionListEntry[]> => {
		if (next === "current") return sessions.list(cwd);
		allEntries ??= await sessions.listAll();
		return allEntries;
	};

	let entries = scope === "current" ? currentEntries : (allEntries ?? []);
	let items = toItems(entries, scope);

	const previewCache = new Map<string, string[]>();

	const result = await runPicker({
		title: "Sessions",
		items,
		maxVisible: SESSION_PICKER_MAX_VISIBLE,
		allowFilter: true,
		statusLine: () =>
			scope === "current"
				? "  ◉ Current folder  |  ○ All   (Tab to switch)"
				: "  ○ Current folder  |  ◉ All   (Tab to switch)",
		onToggleScope: async () => {
			scope = scope === "current" ? "all" : "current";
			entries = await entriesFor(scope);
			if (scope === "current") currentEntries = entries;
			else allEntries = entries;
			items = toItems(entries, scope);
			previewCache.clear();
			return items;
		},
		previewFn: (item, requestRender) => {
			if (!item || item.value === "__new__") return ["  Start a new conversation"];
			if (!preview) return ["  (preview unavailable)"];

			const cached = previewCache.get(item.value);
			if (cached) return cached;

			void preview.getSessionPreview(item.value, SESSION_PREVIEW_LINES).then((lines) => {
				previewCache.set(item.value, lines.length > 0 ? lines : ["  (empty session)"]);
				requestRender?.();
			});
			return ["  Loading..."];
		},
	});

	if (!result || result.value === "__new__") return undefined;
	return result.value;
}
