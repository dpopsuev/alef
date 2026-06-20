import type { SelectItem, SelectList } from "@dpopsuev/alef-tui";
import type { boldColor, color, ThemeTokens } from "./theme.js";
import type { TuiEvent } from "./tui-dispatch.js";
import type { OverlayDescriptor } from "./tui-state.js";

export const HISTORY_PICKER_ID = "history-picker";

/**
 * History provider interface - abstracts access to command history.
 */
export interface HistoryProvider {
	getEntries(): readonly string[];
	addEntry(text: string): void;
}

/**
 * Theme for the history picker select list.
 */
export interface HistoryPickerTheme {
	selectedPrefix: (s: string) => string;
	selectedText: (s: string) => string;
	description: (s: string) => string;
	scrollInfo: (s: string) => string;
	noMatch: (s: string) => string;
}

/**
 * Create a history picker theme from the TUI theme.
 */
export function createHistoryPickerTheme(
	t: ThemeTokens,
	colorFn: typeof color,
	boldColorFn: typeof boldColor,
): HistoryPickerTheme {
	return {
		selectedPrefix: (s: string) => colorFn(s, t.accentFg),
		selectedText: (s: string) => boldColorFn(s, t.accentFg),
		description: (s: string) => colorFn(s, t.mutedFg),
		scrollInfo: (s: string) => colorFn(s, t.mutedFg),
		noMatch: (s: string) => colorFn(s, t.mutedFg),
	};
}

/**
 * Create a history picker overlay.
 */
export function createHistoryPicker(
	historyProvider: HistoryProvider,
	theme: HistoryPickerTheme,
	onSelect: (text: string) => void,
	onClose: () => void,
	SelectListConstructor: new (items: SelectItem[], maxVisible: number, theme: HistoryPickerTheme) => SelectList,
): OverlayDescriptor | null {
	const entries = [...historyProvider.getEntries()];
	if (entries.length === 0) return null;

	const items: SelectItem[] = entries.map((e) => ({
		value: e,
		label: e.length > 60 ? `${e.slice(0, 60)}…` : e,
	}));

	const list = new SelectListConstructor(items, 6, theme);
	list.onSelect = (item: SelectItem) => {
		onSelect(item.value);
		onClose();
	};
	list.onCancel = () => onClose();

	return {
		id: HISTORY_PICKER_ID,
		component: list,
		handleInput: (d) => list.handleInput(d),
	};
}

/**
 * Open the history picker.
 */
export function openHistoryPicker(
	historyProvider: HistoryProvider,
	theme: HistoryPickerTheme,
	onSelect: (text: string) => void,
	dispatch: (event: TuiEvent) => void,
	SelectListConstructor: new (items: SelectItem[], maxVisible: number, theme: HistoryPickerTheme) => SelectList,
): boolean {
	const closeHistoryPicker = () => dispatch({ type: "overlay.hide", id: HISTORY_PICKER_ID });
	const descriptor = createHistoryPicker(historyProvider, theme, onSelect, closeHistoryPicker, SelectListConstructor);
	if (!descriptor) return false;
	dispatch({ type: "overlay.show", descriptor });
	return true;
}
