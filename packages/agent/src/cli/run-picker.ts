import {
	getKeybindings,
	Input,
	matchesKey,
	PreviewSelectList,
	ProcessTerminal,
	type SelectItem,
	Text,
	TUI,
} from "@dpopsuev/alef-tui";
import { bold, color, getTheme } from "./runner-theme.js";

export interface PickerOptions {
	title: string;
	items: SelectItem[];
	maxVisible?: number;
	previewFn: (item: SelectItem | undefined, requestRender?: () => void) => string[];
	allowFilter?: boolean;
	listWidthFraction?: number;
}

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
		const terminal = new ProcessTerminal();
		const tui = new TUI(terminal);

		const modeLabel = new Text(
			color(
				`  NORMAL  j/k navigate  h/l preview${opts.allowFilter ? "  i filter" : ""}  Enter select  Esc cancel`,
				t.mutedFg,
			),
			0,
			0,
		);
		tui.addChild(modeLabel);
		tui.addChild(new Text("", 0, 0));

		const searchInput = opts.allowFilter ? new Input() : undefined;

		const previewList = new PreviewSelectList({
			items: opts.items,
			maxVisible: opts.maxVisible ?? 10,
			theme: listTheme,
			listWidthFraction: opts.listWidthFraction,
			onModeChange: (mode) => {
				if (mode === "insert") {
					modeLabel.setText(color("  INSERT  type to filter  Esc → normal", t.accentFg));
				} else {
					modeLabel.setText(
						color(
							`  NORMAL  j/k navigate  h/l preview${opts.allowFilter ? "  i filter" : ""}  Enter select  Esc cancel`,
							t.mutedFg,
						),
					);
				}
			},
			previewFn: (item) => opts.previewFn(item, () => tui.requestRender()),
		});

		previewList.onSelect = (item) => {
			tui.stop();
			resolve(item);
		};

		if (searchInput) tui.addChild(searchInput);
		tui.addChild(previewList);

		const kb = getKeybindings();

		tui.onRawInput = (data) => {
			if (matchesKey(data, "ctrl+c")) {
				tui.stop();
				resolve(undefined);
				return true;
			}

			if (previewList.mode === "normal" && (kb.matches(data, "tui.select.cancel") || kb.matches(data, "app.quit"))) {
				tui.stop();
				resolve(undefined);
				return true;
			}

			const handled = previewList.handleInput(data);
			if (!handled && searchInput && previewList.mode === "insert") {
				searchInput.handleInput(data);
				previewList.setFilter(searchInput.getValue());
			}
			tui.requestRender();
			return true;
		};

		tui.start();
		if (searchInput) tui.setFocus(searchInput);
		tui.requestRender();
	});
}
