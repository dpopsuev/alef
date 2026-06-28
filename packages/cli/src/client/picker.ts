import { type SelectItem, SelectList, type SelectListTheme } from "@dpopsuev/alef-tui";
import { color, type ThemeTokens } from "./runner-theme.js";
import type { TuiEvent } from "./tui-dispatch.js";

export interface PickerOptions {
	id: string;
	items: SelectItem[];
	maxVisible?: number;
	onSelect: (item: SelectItem) => void;
}

export function buildPickerTheme(t: ThemeTokens): SelectListTheme {
	return {
		selectedPrefix: (s) => color(s, t.accentFg),
		selectedText: (s) => color(s, t.accentFg),
		description: (s) => color(s, t.mutedFg),
		scrollInfo: (s) => color(s, t.mutedFg),
		noMatch: (s) => color(s, t.mutedFg),
	};
}

export function openPicker(
	t: ThemeTokens,
	dispatch: (event: TuiEvent) => void,
	requestRender: () => void,
	opts: PickerOptions,
): void {
	const theme = buildPickerTheme(t);
	const list = new SelectList(opts.items, opts.maxVisible ?? 10, theme).enableSearch();

	const close = () => {
		dispatch({ type: "overlay.hide", id: opts.id });
		requestRender();
	};

	list.onSelect = (item: SelectItem) => {
		close();
		opts.onSelect(item);
	};
	list.onCancel = close;

	dispatch({
		type: "overlay.show",
		descriptor: { id: opts.id, component: list, handleInput: (d) => list.handleInput(d) },
	});
}
