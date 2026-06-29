import type { SelectItem } from "@dpopsuev/alef-tui";
import type { TuiEvent } from "./events.js";
import { openPicker } from "./picker.js";
import type { ThemeTokens } from "./theme.js";

export interface ConfigPickerOptions<T> {
	id: string;
	source: () => readonly T[];
	toItem: (entry: T) => SelectItem;
	onSelect: (entry: T) => void;
	maxVisible?: number;
}

export function openConfigPicker<T>(
	t: ThemeTokens,
	dispatch: (event: TuiEvent) => void,
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

export interface EnumPickerOptions {
	id: string;
	values: readonly string[];
	active?: string;
	onSelect: (value: string) => void;
	maxVisible?: number;
}

export function openEnumPicker(
	t: ThemeTokens,
	dispatch: (event: TuiEvent) => void,
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
