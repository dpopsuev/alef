import type { Component } from "../component.js";
import { fuzzyFilter } from "../fuzzy.js";
import { matchesKey } from "../keys.js";
import { truncateToWidth, visibleWidth } from "../utils.js";

export interface PickerItem {
	label: string;
	description?: string;
	preview?: string;
}

export interface PickerTheme {
	border: (s: string) => string;
	selected: (s: string) => string;
	normal: (s: string) => string;
	dim: (s: string) => string;
	title: (s: string) => string;
}

export interface PickerOptions<T extends PickerItem> {
	items: T[];
	title?: string;
	theme: PickerTheme;
	showPreview?: boolean;
	maxVisible?: number;
	onSelect?: (item: T) => void;
	onCancel?: () => void;
}

export class Picker<T extends PickerItem = PickerItem> implements Component {
	private items: T[];
	private filtered: T[];
	private selectedIndex = 0;
	private scrollOffset = 0;
	private filter = "";
	private filterMode = false;
	private readonly maxVisible: number;
	private readonly theme: PickerTheme;
	private readonly showPreview: boolean;
	private readonly title: string;
	private readonly onSelect?: (item: T) => void;
	private readonly onCancel?: () => void;

	constructor(opts: PickerOptions<T>) {
		this.items = opts.items;
		this.filtered = opts.items;
		this.theme = opts.theme;
		this.showPreview = opts.showPreview ?? false;
		this.maxVisible = opts.maxVisible ?? 12;
		this.title = opts.title ?? "";
		this.onSelect = opts.onSelect;
		this.onCancel = opts.onCancel;
	}

	getSelected(): T | null {
		return this.filtered[this.selectedIndex] ?? null;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const { theme, filtered, selectedIndex, maxVisible, showPreview } = this;
		const lines: string[] = [];

		if (this.title) {
			lines.push(theme.title(this.title));
		}
		lines.push(theme.border("─".repeat(width)));

		if (this.filterMode || this.filter) {
			lines.push(theme.dim(`  filter: ${this.filter}█`));
		}

		const listWidth = showPreview ? Math.floor(width * 0.4) : width;
		const previewWidth = showPreview ? width - listWidth - 1 : 0;

		const end = Math.min(filtered.length, this.scrollOffset + maxVisible);
		const start = this.scrollOffset;

		for (let i = start; i < end; i++) {
			const item = filtered[i];
			const isSel = i === selectedIndex;
			const prefix = isSel ? "  > " : "    ";
			const desc = item.description ? theme.dim(` ${item.description}`) : "";
			const line = truncateToWidth(`${prefix}${item.label}${desc}`, listWidth, "…");
			lines.push(isSel ? theme.selected(line) : theme.normal(line));
		}

		if (filtered.length === 0) {
			lines.push(theme.dim("    (no matches)"));
		}

		if (showPreview && filtered[selectedIndex]?.preview) {
			const previewLines = (filtered[selectedIndex].preview ?? "").split("\n");
			const bodyLines = lines.length - (this.title ? 2 : 1);
			for (let i = 0; i < bodyLines && i < previewLines.length; i++) {
				const contentLine = lines[(this.title ? 2 : 1) + i];
				const pl = truncateToWidth(previewLines[i], previewWidth, "…");
				const gap = Math.max(0, listWidth + 1 - visibleWidth(contentLine));
				lines[(this.title ? 2 : 1) + i] = `${contentLine}${" ".repeat(gap)}${theme.dim(pl)}`;
			}
		}

		const hint = this.filterMode ? "type to filter, Esc to stop" : "j/k navigate, / filter, Enter select, Esc cancel";
		lines.push(theme.border("─".repeat(width)));
		lines.push(theme.dim(`  ${hint}`));

		return lines;
	}

	handleInput(data: string): boolean {
		if (this.filterMode) {
			if (data === "\x1b") {
				this.filterMode = false;
				return true;
			}
			if (data === "\x7f" || data === "\b") {
				this.filter = this.filter.slice(0, -1);
				this.applyFilter();
				return true;
			}
			if (data === "\r") {
				this.filterMode = false;
				return true;
			}
			if (data.length === 1 && data >= " ") {
				this.filter += data;
				this.applyFilter();
				return true;
			}
			return true;
		}

		if (data === "/" || data === "i") {
			this.filterMode = true;
			return true;
		}
		if (matchesKey(data, "down") || data === "j") {
			this.moveSelection(1);
			return true;
		}
		if (matchesKey(data, "up") || data === "k") {
			this.moveSelection(-1);
			return true;
		}
		if (data === "\r") {
			const sel = this.getSelected();
			if (sel) this.onSelect?.(sel);
			return true;
		}
		if (data === "\x1b" || data === "q") {
			this.onCancel?.();
			return true;
		}
		return false;
	}

	private moveSelection(delta: number): void {
		const len = this.filtered.length;
		if (len === 0) return;
		this.selectedIndex = (this.selectedIndex + delta + len) % len;
		if (this.selectedIndex < this.scrollOffset) this.scrollOffset = this.selectedIndex;
		if (this.selectedIndex >= this.scrollOffset + this.maxVisible) {
			this.scrollOffset = this.selectedIndex - this.maxVisible + 1;
		}
	}

	private applyFilter(): void {
		if (!this.filter) {
			this.filtered = this.items;
		} else {
			this.filtered = fuzzyFilter(this.items, this.filter, (item) => `${item.label} ${item.description ?? ""}`);
		}
		this.selectedIndex = 0;
		this.scrollOffset = 0;
	}
}
