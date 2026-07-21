/**
 * Overlay pickers used by TUI colon commands.
 */

import { type SelectItem, SelectList, type SelectListTheme } from "@dpopsuev/alef-tui";
import type { DispatchEvent } from "../events.js";
import { selectListThemeFromTokens, type ThemeTokens } from "../theme.js";

const SETTINGS_MAX_VISIBLE = 10;

/** Options for a typed overlay picker backed by an arbitrary data source. */
export interface ConfigPickerOptions<T> {
	id: string;
	source: () => readonly T[];
	toItem: (entry: T) => SelectItem;
	onSelect: (entry: T) => void;
	maxVisible?: number;
}

/** Open a typed overlay picker that maps domain objects to selectable items. */
export function openConfigPicker<T>(
	t: ThemeTokens,
	dispatch: (event: DispatchEvent) => void,
	requestRender: () => void,
	opts: ConfigPickerOptions<T>,
): void {
	const entries = opts.source();
	const entryMap = new Map<string, T>();
	const items: SelectItem[] = entries.map((entry) => {
		const item = opts.toItem(entry);
		entryMap.set(item.value, entry);
		return item;
	});

	openPicker(t, dispatch, requestRender, {
		id: opts.id,
		items,
		maxVisible: opts.maxVisible,
		onSelect: (item) => {
			const entry = entryMap.get(item.value);
			if (entry) opts.onSelect(entry);
		},
	});
}

/** Options for an overlay picker over a fixed set of string values. */
export interface EnumPickerOptions {
	id: string;
	values: readonly string[];
	active?: string;
	onSelect: (value: string) => void;
	maxVisible?: number;
}

/** Open an overlay picker for choosing among a fixed set of string values. */
export function openEnumPicker(
	t: ThemeTokens,
	dispatch: (event: DispatchEvent) => void,
	requestRender: () => void,
	opts: EnumPickerOptions,
): void {
	const items: SelectItem[] = opts.values.map((v) => ({
		value: v,
		label: v === opts.active ? `${v} *` : v,
	}));

	openPicker(t, dispatch, requestRender, {
		id: opts.id,
		items,
		maxVisible: opts.maxVisible ?? opts.values.length,
		onSelect: (item) => opts.onSelect(item.value),
	});
}

/** Options for a generic overlay picker with pre-built SelectItem entries. */
export interface PickerOptions {
	id: string;
	items: SelectItem[];
	maxVisible?: number;
	onSelect: (item: SelectItem) => void;
}

/** Create a SelectListTheme from the active TUI color tokens. */
export function buildPickerTheme(t: ThemeTokens): SelectListTheme {
	return selectListThemeFromTokens(t, "accent");
}

/** Open a searchable overlay picker and dispatch show/hide events on select or cancel. */
export function openPicker(
	t: ThemeTokens,
	dispatch: (event: DispatchEvent) => void,
	requestRender: () => void,
	opts: PickerOptions,
): void {
	const theme = buildPickerTheme(t);
	const list = new SelectList(opts.items, opts.maxVisible ?? SETTINGS_MAX_VISIBLE, theme).enableSearch();

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
	requestRender();
}
