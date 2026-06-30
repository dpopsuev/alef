import {
	getKeybindings,
	Input,
	matchesKey,
	PreviewSelectList,
	ProcessTerminal,
	type SelectItem,
	type Terminal,
	Text,
	TUI,
} from "@dpopsuev/alef-tui";
import { bold, color, getTheme } from "../theme.js";

/** Configuration for a standalone vi-modal picker with preview pane. */
export interface PickerOptions {
	title: string;
	items: SelectItem[];
	maxVisible?: number;
	previewFn: (item: SelectItem | undefined, requestRender?: () => void) => string[];
	allowFilter?: boolean;
	listWidthFraction?: number;
	terminal?: Terminal;
}

/** Route raw key input to the preview list, search input, or close action. */
function handlePickerInput(
	data: string,
	list: PreviewSelectList,
	searchInput: Input | undefined,
	close: () => void,
): boolean {
	const kb = getKeybindings();

	if (matchesKey(data, "ctrl+c")) {
		close();
		return true;
	}

	if (list.mode === "normal" && (kb.matches(data, "tui.select.cancel") || kb.matches(data, "app.quit"))) {
		close();
		return true;
	}

	const handled = list.handleInput(data);
	if (!handled && searchInput && list.mode === "insert") {
		searchInput.handleInput(data);
		list.setFilter(searchInput.getValue());
	}

	return true;
}

/** Run a standalone vi-modal picker with preview pane and return the selected item. */
export async function runPicker(opts: PickerOptions): Promise<SelectItem | undefined> {
	if (opts.items.length === 0) return undefined;

	const t = getTheme();

	const listTheme = {
		selectedPrefix: (s: string) => color(s, t.accentFg),
		selectedText: (s: string) => bold(s),
		description: (s: string) => color(s, t.mutedFg),
		scrollInfo: (s: string) => color(s, t.mutedFg),
		noMatch: (s: string) => color(s, t.mutedFg),
	};

	return new Promise<SelectItem | undefined>((resolve) => {
		const terminal = opts.terminal ?? new ProcessTerminal();
		const tui = new TUI(terminal);

		const normalHint = `  NORMAL  j/k navigate  h/l preview${opts.allowFilter ? "  i filter" : ""}  Enter select  Esc cancel`;
		const insertHint = "  INSERT  type to filter  Esc → normal";

		const modeLabel = new Text(color(normalHint, t.mutedFg), 0, 0);
		tui.addChild(modeLabel);
		tui.addChild(new Text("", 0, 0));

		const searchInput = opts.allowFilter ? new Input() : undefined;

		const previewList = new PreviewSelectList({
			items: opts.items,
			maxVisible: opts.maxVisible ?? 10,
			theme: listTheme,
			listWidthFraction: opts.listWidthFraction,
			onModeChange: (mode) => {
				modeLabel.setText(
					color(mode === "insert" ? insertHint : normalHint, mode === "insert" ? t.accentFg : t.mutedFg),
				);
			},
			previewFn: (item) => opts.previewFn(item, () => tui.requestRender()),
		});

		const close = () => {
			tui.stop();
			resolve(undefined);
		};

		previewList.onSelect = (item) => {
			tui.stop();
			resolve(item);
		};

		if (searchInput) tui.addChild(searchInput);
		tui.addChild(previewList);

		tui.onRawInput = (data) => {
			handlePickerInput(data, previewList, searchInput, close);
			tui.requestRender();
			return true;
		};

		tui.start();
		if (searchInput) tui.setFocus(searchInput);
		tui.requestRender();
	});
}
