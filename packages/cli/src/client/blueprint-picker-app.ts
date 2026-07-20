/**
 * In-TUI blueprint picker -- renders blueprint selection inside the main
 * TUI's scrollback area, replacing the standalone runPicker TUI.
 */

import { matchesKey, type SelectItem, SelectList } from "@dpopsuev/alef-tui";
import type { TuiShell } from "./boot-types.js";
import { getTheme, selectListThemeFromTokens } from "./theme.js";

/** A discovered blueprint entry. */
export interface BlueprintChoice {
	name: string;
	description: string;
	path: string;
}

/**
 * Run the blueprint picker inside an existing TUI shell.
 *
 * Returns the selected blueprint, or undefined if cancelled (exits process).
 * Returns the single blueprint immediately when only one is available.
 */
export async function pickBlueprintInTui(
	shell: TuiShell,
	choices: BlueprintChoice[],
): Promise<BlueprintChoice | undefined> {
	if (choices.length <= 1) return choices[0];

	const t = getTheme();
	const listTheme = selectListThemeFromTokens(t, "accent-bold-text");

	const items: SelectItem[] = choices.map((bp) => ({
		value: bp.path,
		label: bp.name,
		description: bp.description.slice(0, 60),
	}));

	const list = new SelectList(items, Math.min(10, items.length), listTheme);

	const { writer, tui } = shell;
	const listContainer = writer.container;
	listContainer.addChild(list);
	tui.requestRender();

	const savedRawInput = tui.onRawInput;

	return new Promise<BlueprintChoice | undefined>((resolve) => {
		const cleanup = (): void => {
			listContainer.removeChild(list);
			tui.onRawInput = savedRawInput;
			tui.requestRender();
		};

		list.onSelect = (item) => {
			cleanup();
			resolve(choices.find((c) => c.path === item.value));
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
			list.handleInput(data);
			tui.requestRender();
			return true;
		};
	});
}
