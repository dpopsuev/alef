import type { Component } from "../component.js";
import { truncateToWidth, visibleWidth } from "../utils.js";
import type { SelectItem, SelectListLayoutOptions, SelectListTheme } from "./select-list.js";
import { SelectList } from "./select-list.js";

export interface PreviewSelectListOptions {
	items: SelectItem[];
	maxVisible: number;
	theme: SelectListTheme;
	layout?: SelectListLayoutOptions;
	previewFn: (item: SelectItem | undefined) => string[];
	listWidthFraction?: number;
	borderChar?: string;
}

function padLine(line: string, targetWidth: number): string {
	const w = visibleWidth(line);
	return w >= targetWidth ? line : line + " ".repeat(targetWidth - w);
}

export class PreviewSelectList implements Component {
	readonly list: SelectList;
	private previewFn: (item: SelectItem | undefined) => string[];
	private listWidthFraction: number;
	private borderChar: string;
	private currentPreview: string[] = [];

	constructor(opts: PreviewSelectListOptions) {
		this.list = new SelectList(opts.items, opts.maxVisible, opts.theme, opts.layout);
		this.previewFn = opts.previewFn;
		this.listWidthFraction = opts.listWidthFraction ?? 0.4;
		this.borderChar = opts.borderChar ?? "│";

		this.list.onSelectionChange = (item) => {
			this.currentPreview = this.previewFn(item);
		};

		if (opts.items.length > 0) {
			this.currentPreview = this.previewFn(opts.items[0]);
		}
	}

	set onSelect(fn: ((item: SelectItem) => void) | undefined) {
		this.list.onSelect = fn;
	}

	set onCancel(fn: (() => void) | undefined) {
		this.list.onCancel = fn;
	}

	setFilter(filter: string): void {
		this.list.setFilter(filter);
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}

	invalidate(): void {
		this.list.invalidate();
		this.currentPreview = [];
	}

	render(width: number): string[] {
		if (width < 60) {
			return this.list.render(width);
		}

		const listWidth = Math.max(20, Math.floor(width * this.listWidthFraction));
		const borderWidth = 1;
		const previewWidth = Math.max(10, width - listWidth - borderWidth - 1);

		const leftLines = this.list.render(listWidth);
		const rightLines = this.currentPreview.map((l) => truncateToWidth(` ${l}`, previewWidth, "…"));

		const maxLines = Math.max(leftLines.length, rightLines.length);
		const merged: string[] = [];

		for (let i = 0; i < maxLines; i++) {
			const left = padLine(leftLines[i] ?? "", listWidth);
			const right = rightLines[i] ?? "";
			merged.push(`${left}${this.borderChar}${right}`);
		}

		return merged;
	}
}
