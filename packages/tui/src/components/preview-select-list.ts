import type { Component } from "../component.js";
import { truncateToWidth, visibleWidth } from "../utils.js";
import type { SelectItem, SelectListLayoutOptions, SelectListTheme } from "./select-list.js";
import { SelectList } from "./select-list.js";

export type PickerMode = "normal" | "insert";

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
	private _mode: PickerMode = "normal";
	private onModeChange?: (mode: PickerMode) => void;

	constructor(opts: PreviewSelectListOptions) {
		this.list = new SelectList(opts.items, opts.maxVisible, opts.theme, opts.layout);
		this.previewFn = opts.previewFn;
		this.listWidthFraction = opts.listWidthFraction ?? 0.4;
		this.borderChar = opts.borderChar ?? "│";
		this.onModeChange = opts.onModeChange;

		this.list.onSelectionChange = (item) => {
			this.currentPreview = this.previewFn(item);
			this.previewScrollOffset = 0;
		};

		if (opts.items.length > 0) {
			this.currentPreview = this.previewFn(opts.items[0]);
		}
	}

	get mode(): PickerMode {
		return this._mode;
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
		if (this._mode === "insert") {
			if (data === "\x1b") {
				this._mode = "normal";
				this.previewFocused = false;
				this.onModeChange?.("normal");
				return true;
			}
			return false;
		}

		// Normal mode
		if (data === "i" || data === "/") {
			this._mode = "insert";
			this.previewFocused = false;
			this.onModeChange?.("insert");
			return true;
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
			if (data === "j" || data === "\x1b[B") {
				this.previewScrollOffset = Math.min(
					this.previewScrollOffset + 1,
					Math.max(0, this.currentPreview.length - 1),
				);
				return true;
			}
			if (data === "k" || data === "\x1b[A") {
				this.previewScrollOffset = Math.max(0, this.previewScrollOffset - 1);
				return true;
			}
			if (data === "g") {
				this.previewScrollOffset = 0;
				return true;
			}
			if (data === "G") {
				this.previewScrollOffset = Math.max(0, this.currentPreview.length - 6);
				return true;
			}
			return true;
		}

		// List navigation in normal mode
		if (data === "j" || data === "\x1b[B") {
			this.list.handleInput("\x1b[B");
			return true;
		}
		if (data === "k" || data === "\x1b[A") {
			this.list.handleInput("\x1b[A");
			return true;
		}
		if (data === "\r" || data === "\n") {
			this.list.handleInput(data);
			return true;
		}
		if (data === "\x1b[A" || data === "\x1b[B") {
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
