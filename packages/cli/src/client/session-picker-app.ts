/**
 * In-TUI session picker -- renders session selection inside the main
 * TUI's scrollback area, replacing the standalone runPicker TUI.
 *
 * Takes over raw input routing while active. Restores original handler
 * on completion. Resolves with the selected session ID, or undefined
 * for "new session".
 */

import type { SessionListEntry, SessionStoreFactory } from "@dpopsuev/alef-storage";
import { matchesKey, type SelectItem, SelectList } from "@dpopsuev/alef-tui";
import type { TuiShell } from "./boot-types.js";
import { getTheme, selectListThemeFromTokens } from "./theme.js";

const SESSION_PICKER_MAX_VISIBLE = 12;

type SessionScope = "current" | "all";

/** Shorten a cwd path for display. */
function shortenCwd(cwd: string | undefined): string {
	if (!cwd) return "";
	const home = process.env.HOME;
	const display = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
	const parts = display.split("/").filter(Boolean);
	if (parts.length <= 2) return display;
	return parts.slice(-2).join("/");
}

/** Format a date for display. */
function formatMtime(mtime: Date): string {
	return mtime.toISOString().replace("T", " ").slice(0, 16);
}

/** Convert session entries to SelectList items. */
function toItems(entries: SessionListEntry[], scope: SessionScope): SelectItem[] {
	return [
		{ value: "__new__", label: "New session", description: "Start fresh" },
		...entries.map((s) => {
			const tags = s.tags?.length ? ` -- ${s.tags.join(" ")}` : "";
			const cwdPart = scope === "all" && s.cwd ? `${shortenCwd(s.cwd)} -- ` : "";
			return {
				value: s.id,
				label: s.name ?? s.id,
				description: `${cwdPart}${formatMtime(s.mtime)}${tags}`,
				searchText: [s.name, s.id, ...(s.tags ?? []), s.searchBlob ?? "", s.cwd ?? ""].filter(Boolean).join(" "),
			};
		}),
	];
}

/** Dependencies for the session picker. */
export interface SessionPickerDeps {
	cwd: string;
	sessions: SessionStoreFactory;
}

/**
 * Run the session picker inside an existing TUI shell.
 *
 * Adds a SelectList to the scrollback area and takes over raw input.
 * Resolves with the selected session ID, or undefined for "new session".
 * Returns undefined immediately if no sessions exist.
 */
export async function pickSessionInTui(shell: TuiShell, deps: SessionPickerDeps): Promise<string | undefined> {
	const { cwd, sessions } = deps;
	const t = getTheme();
	const listTheme = selectListThemeFromTokens(t, "accent-bold-text");

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

	const list = new SelectList(items, SESSION_PICKER_MAX_VISIBLE, listTheme);
	list.enableSearch();

	const { writer, tui } = shell;
	const listContainer = writer.container;
	listContainer.addChild(list);
	tui.requestRender();

	const savedRawInput = tui.onRawInput;

	return new Promise<string | undefined>((resolve) => {
		const cleanup = (): void => {
			listContainer.removeChild(list);
			tui.onRawInput = savedRawInput;
			tui.requestRender();
		};

		list.onSelect = (item) => {
			cleanup();
			resolve(item.value === "__new__" ? undefined : item.value);
		};

		list.onCancel = () => {
			cleanup();
			process.exit(0);
		};

		tui.onRawInput = (data) => {
			if (matchesKey(data, "ctrl+c")) {
				cleanup();
				process.exit(0);
				return true;
			}

			if (matchesKey(data, "tab")) {
				void (async () => {
					scope = scope === "current" ? "all" : "current";
					entries = await entriesFor(scope);
					if (scope === "current") currentEntries = entries;
					else allEntries = entries;
					items = toItems(entries, scope);
					list.setItems(items);
					tui.requestRender();
				})();
				return true;
			}

			list.handleInput(data);
			tui.requestRender();
			return true;
		};
	});
}
