import type { Component } from "../component.js";
import { matchesKey } from "../keys.js";
import { truncateToWidth, visibleWidth } from "../utils.js";
import { ViModal, type ViMode } from "../vi-modal.js";
import type { SelectItem, SelectListLayoutOptions, SelectListTheme } from "./select-list.js";
import { SelectList } from "./select-list.js";

export type PickerMode = ViMode;

export interface PreviewSelectListOptions {
	items: SelectItem[];
	maxVisible: number;
	theme: SelectListTheme;
	layout?: SelectListLayoutOptions;
	previewFn: (item: SelectItem | undefined) => string[];
	listWidthFraction?: number;
	borderChar?: string;
	onModeChange?: (mode: PickerMode) => void;
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
	private previewFocused = false;
	private previewScrollOffset = 0;
	private _selectedItem: SelectItem | undefined;
	private vi: ViModal;

	constructor(opts: PreviewSelectListOptions) {
		this.list = new SelectList(opts.items, opts.maxVisible, opts.theme, opts.layout);
		this.previewFn = opts.previewFn;
		this.listWidthFraction = opts.listWidthFraction ?? 0.4;
		this.borderChar = opts.borderChar ?? "│";
		this.vi = new ViModal({ onModeChange: opts.onModeChange });

		this.list.onSelectionChange = (item) => {
			this._selectedItem = item;
			this.currentPreview = this.previewFn(item);
			this.previewScrollOffset = 0;
		};

		if (opts.items.length > 0) {
			this._selectedItem = opts.items[0];
			this.currentPreview = this.previewFn(opts.items[0]);
		}
	}

	get mode(): PickerMode {
		return this.vi.mode;
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

	handleInput(data: string): boolean {
		const viResult = this.vi.handleKey(data);
		if (viResult === "mode-change") {
			if (this.vi.isNormal()) this.previewFocused = false;
			return true;
		}

		if (this.vi.isInsert()) {
			return false;
		}

		if (data === "l") {
			this.previewFocused = true;
			return true;
		}
		if (data === "h") {
			this.previewFocused = false;
			return true;
		}

		if (this.previewFocused) {
			if (matchesKey(data, "down") || matchesKey(data, "j")) {
				this.previewScrollOffset = Math.min(
					this.previewScrollOffset + 1,
					Math.max(0, this.currentPreview.length - 1),
				);
				return true;
			}
			if (matchesKey(data, "up") || matchesKey(data, "k")) {
				this.previewScrollOffset = Math.max(0, this.previewScrollOffset - 1);
				return true;
			}
			if (matchesKey(data, "g")) {
				this.previewScrollOffset = 0;
				return true;
			}
			if (matchesKey(data, "shift+g")) {
				this.previewScrollOffset = Math.max(0, this.currentPreview.length - 6);
				return true;
			}
			return true;
		}

		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.list.handleInput(data);
			return true;
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.list.handleInput(data);
			return true;
		}
		if (matchesKey(data, "enter")) {
			this.list.handleInput(data);
			return true;
		}

		return false;
	}

	invalidate(): void {
		this.list.invalidate();
		this.currentPreview = [];
		this.previewScrollOffset = 0;
	}

	render(width: number): string[] {
		if (width < 60) {
			return this.list.render(width);
		}

		if (this._selectedItem !== undefined) {
			this.currentPreview = this.previewFn(this._selectedItem);
		}

		const listWidth = Math.max(20, Math.floor(width * this.listWidthFraction));
		const borderWidth = 1;
		const previewWidth = Math.max(10, width - listWidth - borderWidth - 1);

		const leftLines = this.list.render(listWidth);
		const visiblePreviewHeight = Math.max(leftLines.length, 6);
		const scrolled = this.currentPreview.slice(
			this.previewScrollOffset,
			this.previewScrollOffset + visiblePreviewHeight,
		);
		const rightLines = scrolled.map((l) => truncateToWidth(` ${l}`, previewWidth, "…"));

		const border = this.previewFocused ? "┃" : this.borderChar;
		const maxLines = Math.max(leftLines.length, rightLines.length);
		const merged: string[] = [];

		for (let i = 0; i < maxLines; i++) {
			const left = padLine(leftLines[i] ?? "", listWidth);
			const right = rightLines[i] ?? "";
			merged.push(`${left}${border}${right}`);
		}

		if (this.currentPreview.length > visiblePreviewHeight) {
			const indicator = `${this.previewScrollOffset + 1}-${Math.min(this.previewScrollOffset + visiblePreviewHeight, this.currentPreview.length)}/${this.currentPreview.length}`;
			merged.push(`${padLine("", listWidth)}${border} ${indicator}`);
		}

		return merged;
	}
}
