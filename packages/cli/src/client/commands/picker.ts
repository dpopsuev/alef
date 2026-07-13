const PICKER_MAX_VISIBLE = 10;

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
import { color, getTheme, selectListThemeFromTokens } from "../theme.js";

/** Configuration for a standalone vi-modal picker with preview pane. */
export interface PickerOptions {
	title: string;
	items: SelectItem[];
	maxVisible?: number;
	previewFn: (item: SelectItem | undefined, previewWidth: number, requestRender?: () => void) => string[];
	allowFilter?: boolean;
	listWidthFraction?: number;
	terminal?: Terminal;
	/** Extra status line under the mode hint (e.g. scope indicator). */
	statusLine?: () => string;
	/** Tab in normal mode — e.g. toggle cwd/all scope. Return new items. */
	onToggleScope?: () => SelectItem[] | Promise<SelectItem[]>;
	/** Preview pane hit the top while scrolling — load older history. */
	onPreviewNeedMore?: (item: SelectItem) => void;
}

/** Route raw key input to the preview list, search input, or close action. */
function handlePickerInput(
	data: string,
	list: PreviewSelectList,
	searchInput: Input | undefined,
	close: () => void,
	onToggleScope?: () => SelectItem[] | Promise<SelectItem[]>,
	onScopeToggled?: (items: SelectItem[]) => void,
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

	if (list.mode === "normal" && matchesKey(data, "tab") && onToggleScope) {
		void Promise.resolve(onToggleScope()).then((items) => {
			list.setItems(items);
			onScopeToggled?.(items);
		});
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

	const listTheme = selectListThemeFromTokens(t, "accent-bold-text");

	return new Promise<SelectItem | undefined>((resolve) => {
		const terminal = opts.terminal ?? new ProcessTerminal();
		const tui = new TUI(terminal);

		const scopeHint = opts.onToggleScope ? "  Tab scope" : "";
		const normalHint = `  NORMAL  j/k navigate  h/l preview  z read${opts.allowFilter ? "  i filter" : ""}${scopeHint}  Enter select  Esc cancel`;
		const insertHint = "  INSERT  type to filter  Esc → normal";
		const readingHint = "  READ-ONLY  j/k scroll  g/G top/end  z/Esc back  (Enter disabled)";

		const modeLabel = new Text(color(normalHint, t.mutedFg), 0, 0);
		const statusLabel = new Text(color(opts.statusLine?.() ?? "", t.mutedFg), 0, 0);
		tui.addChild(modeLabel);
		tui.addChild(statusLabel);
		tui.addChild(new Text("", 0, 0));

		const searchInput = opts.allowFilter ? new Input() : undefined;

		const previewList = new PreviewSelectList({
			items: opts.items,
			maxVisible: opts.maxVisible ?? PICKER_MAX_VISIBLE,
			theme: listTheme,
			listWidthFraction: opts.listWidthFraction,
			pinPreviewToEnd: true,
			onModeChange: (mode) => {
				if (previewList.isReading) return;
				modeLabel.setText(
					color(mode === "insert" ? insertHint : normalHint, mode === "insert" ? t.accentFg : t.mutedFg),
				);
			},
			onReadingChange: (reading) => {
				modeLabel.setText(color(reading ? readingHint : normalHint, reading ? t.accentFg : t.mutedFg));
			},
			previewFn: (item, previewWidth) => opts.previewFn(item, previewWidth, () => tui.requestRender()),
			onPreviewNeedMore: opts.onPreviewNeedMore,
		});

		const refreshStatus = () => {
			statusLabel.setText(color(opts.statusLine?.() ?? "", t.mutedFg));
		};

		const close = () => {
			tui.stop();
			resolve(undefined);
		};

		previewList.onSelect = (item) => {
			if (previewList.isReading) return;
			tui.stop();
			resolve(item);
		};

		if (searchInput) tui.addChild(searchInput);
		tui.addChild(previewList);

		tui.onRawInput = (data) => {
			const kb = getKeybindings();
			if (
				previewList.isReading &&
				(matchesKey(data, "escape") || kb.matches(data, "tui.select.cancel") || kb.matches(data, "app.quit"))
			) {
				previewList.exitReading();
				tui.requestRender();
				return true;
			}

			handlePickerInput(data, previewList, searchInput, close, opts.onToggleScope, () => {
				refreshStatus();
				tui.requestRender();
			});
			tui.requestRender();
			return true;
		};

		tui.start();
		if (searchInput) tui.setFocus(searchInput);
		tui.requestRender();
	});
}
