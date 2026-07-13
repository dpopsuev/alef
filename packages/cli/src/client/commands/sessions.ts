/**
 * TUI session picker — vi-modal with preview pane, cwd/all scope, content search.
 */

import type { SessionListEntry, SessionPreviewProvider, SessionStoreFactory } from "@dpopsuev/alef-storage";
import type { SelectItem } from "@dpopsuev/alef-tui";
import { renderDisplayBlocksToLines } from "@dpopsuev/alef-tui/views";
import { getTheme } from "../theme.js";
import { runPicker } from "./picker.js";
import {
	type PreviewCacheEntry,
	previewPaneLines,
	SESSION_PREVIEW_TURNS_INITIAL,
	SESSION_PREVIEW_TURNS_MAX,
	SESSION_PREVIEW_TURNS_STEP,
	settlePreviewFailure,
	settlePreviewSuccess,
	shouldLoadPreview,
} from "./session-preview-cache.js";

const SESSION_PICKER_MAX_VISIBLE = 12;

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

	const previewCache = new Map<string, PreviewCacheEntry>();
	let requestRender: (() => void) | undefined;

	const loadPreview = (sessionId: string, turns: number): void => {
		if (!preview) return;
		const existing = previewCache.get(sessionId);
		if (!shouldLoadPreview(existing, turns)) return;

		previewCache.set(sessionId, {
			turns,
			blocks: existing?.blocks ?? [],
			exhausted: existing?.exhausted ?? false,
			loading: true,
		});

		void preview.getSessionPreview(sessionId, turns).then(
			(blocks) => {
				previewCache.set(sessionId, settlePreviewSuccess(previewCache.get(sessionId), turns, blocks));
				requestRender?.();
			},
			(error: unknown) => {
				previewCache.set(sessionId, settlePreviewFailure(previewCache.get(sessionId), turns, error));
				requestRender?.();
			},
		);
	};

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
		onPreviewNeedMore: (item) => {
			if (item.value === "__new__" || !preview) return;
			const cached = previewCache.get(item.value);
			if (!cached || cached.loading || cached.exhausted) return;
			const nextTurns = Math.min(cached.turns + SESSION_PREVIEW_TURNS_STEP, SESSION_PREVIEW_TURNS_MAX);
			if (nextTurns <= cached.turns) return;
			loadPreview(item.value, nextTurns);
		},
		previewFn: (item, previewWidth, render) => {
			requestRender = render;
			if (!item || item.value === "__new__") return ["  Start a new conversation"];
			if (!preview) return ["  (preview unavailable)"];

			const pane = previewPaneLines(previewCache.get(item.value), (blocks) =>
				renderDisplayBlocksToLines(blocks, previewWidth, getTheme()),
			);
			if (pane === "start-load") {
				loadPreview(item.value, SESSION_PREVIEW_TURNS_INITIAL);
				return ["  Loading..."];
			}
			if (pane === "loading") return ["  Loading..."];
			return pane;
		},
	});

	if (!result || result.value === "__new__") return undefined;
	return result.value;
}
