import type { Component } from "../component.js";
import { matchesKey } from "../keys.js";
import { truncateToWidth, visibleWidth } from "../utils.js";
import { ViModal, type ViMode } from "../vi-modal.js";
import type { SelectItem, SelectListLayoutOptions, SelectListTheme } from "./select-list.js";
import { SelectList } from "./select-list.js";

/**
 *
 */
export type PickerMode = ViMode;

/**
 *
 */
export interface PreviewSelectListOptions {
	items: SelectItem[];
	maxVisible: number;
	theme: SelectListTheme;
	layout?: SelectListLayoutOptions;
	/** Width-aware preview so ChatLog hosting can wrap like the live session. */
	previewFn: (item: SelectItem | undefined, previewWidth: number) => string[];
	listWidthFraction?: number;
	borderChar?: string;
	onModeChange?: (mode: PickerMode) => void;
	/** Pin first paint of a selection to the bottom (most recent). Default true. */
	pinPreviewToEnd?: boolean;
	/** Fired when preview-focused scroll hits the top — load older history. */
	onPreviewNeedMore?: (item: SelectItem) => void;
	/** Fired when read-only reading mode is entered or left (z). */
	onReadingChange?: (reading: boolean) => void;
	/** Visible height when in read-only reading mode. Default: max(24, maxVisible * 2). */
	readingMaxVisible?: number;
}

/**
 *
 */
function padLine(line: string, targetWidth: number): string {
	const w = visibleWidth(line);
	return w >= targetWidth ? line : line + " ".repeat(targetWidth - w);
}

/**
 *
 */
export class PreviewSelectList implements Component {
	readonly list: SelectList;
	private previewFn: (item: SelectItem | undefined, previewWidth: number) => string[];
	private listWidthFraction: number;
	private borderChar: string;
	private currentPreview: string[] = [];
	private previewFocused = false;
	private reading = false;
	private _previewScrollOffset = 0;
	private _selectedItem: SelectItem | undefined;
	private vi: ViModal;
	private lastPreviewWidth = 0;
	private lastVisiblePreviewHeight = 6;
	private pinPreviewToEnd: boolean;
	private shouldPinToEnd = false;
	private onPreviewNeedMore?: (item: SelectItem) => void;
	private onReadingChange?: (reading: boolean) => void;
	private readingMaxVisible: number;

	constructor(opts: PreviewSelectListOptions) {
		this.list = new SelectList(opts.items, opts.maxVisible, opts.theme, opts.layout);
		this.previewFn = opts.previewFn;
		this.listWidthFraction = opts.listWidthFraction ?? 0.4;
		this.borderChar = opts.borderChar ?? "│";
		this.pinPreviewToEnd = opts.pinPreviewToEnd ?? true;
		this.onPreviewNeedMore = opts.onPreviewNeedMore;
		this.onReadingChange = opts.onReadingChange;
		this.readingMaxVisible = opts.readingMaxVisible ?? Math.max(24, opts.maxVisible * 2);
		this.vi = new ViModal({ onModeChange: opts.onModeChange });

		this.list.onSelectionChange = (item) => {
			this._selectedItem = item;
			this.shouldPinToEnd = this.pinPreviewToEnd;
			this._previewScrollOffset = 0;
			if (this.reading && item.value === "__new__") this.setReading(false);
			this.refreshPreview(this.lastPreviewWidth);
		};

		if (opts.items.length > 0) {
			this._selectedItem = opts.items[0];
			this.shouldPinToEnd = this.pinPreviewToEnd;
		}
	}

	get mode(): PickerMode {
		return this.vi.mode;
	}

	get isReading(): boolean {
		return this.reading;
	}

	get previewScrollOffset(): number {
		return this._previewScrollOffset;
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

	setItems(items: SelectItem[]): void {
		this.list.setItems(items);
		if (items.length > 0) {
			this._selectedItem = items[0];
			this.shouldPinToEnd = this.pinPreviewToEnd;
		} else {
			this._selectedItem = undefined;
			this.currentPreview = [];
		}
		this._previewScrollOffset = 0;
		if (this.reading) this.setReading(false);
		this.refreshPreview(this.lastPreviewWidth);
	}

	/** Leave read-only reading mode. Returns true if it was active. */
	exitReading(): boolean {
		if (!this.reading) return false;
		this.setReading(false);
		return true;
	}

	handleInput(data: string): boolean {
		const viResult = this.vi.handleKey(data);
		if (viResult === "mode-change") {
			if (this.vi.isNormal()) {
				this.previewFocused = false;
				if (this.reading) this.setReading(false);
			}
			return true;
		}

		if (this.vi.isInsert()) {
			return false;
		}

		if (data === "z") {
			if (!this._selectedItem || this._selectedItem.value === "__new__") return true;
			this.setReading(!this.reading);
			return true;
		}

		if (this.reading) {
			return this.handleReadingInput(data);
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
			return this.handlePreviewScroll(data);
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
		this._previewScrollOffset = 0;
	}

	render(width: number): string[] {
		if (this.reading) {
			return this.renderReading(width);
		}

		if (width < 60) {
			return this.list.render(width);
		}

		const listWidth = Math.max(20, Math.floor(width * this.listWidthFraction));
		const borderWidth = 1;
		const previewWidth = Math.max(10, width - listWidth - borderWidth - 1);
		this.lastPreviewWidth = previewWidth;

		if (this._selectedItem !== undefined) {
			this.refreshPreview(Math.max(1, previewWidth - 1));
		}

		const leftLines = this.list.render(listWidth);
		const visiblePreviewHeight = Math.max(leftLines.length, 6);
		this.lastVisiblePreviewHeight = visiblePreviewHeight;

		if (this.shouldPinToEnd && this.currentPreview.length > 0) {
			this._previewScrollOffset = Math.max(0, this.currentPreview.length - visiblePreviewHeight);
			this.shouldPinToEnd = false;
		}

		const scrolled = this.currentPreview.slice(
			this._previewScrollOffset,
			this._previewScrollOffset + visiblePreviewHeight,
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
			const indicator = `${this._previewScrollOffset + 1}-${Math.min(this._previewScrollOffset + visiblePreviewHeight, this.currentPreview.length)}/${this.currentPreview.length}`;
			merged.push(`${padLine("", listWidth)}${border} ${indicator}`);
		}

		return merged;
	}

	private setReading(next: boolean): void {
		if (this.reading === next) return;
		this.reading = next;
		if (next) {
			this.previewFocused = true;
			this.shouldPinToEnd = this.pinPreviewToEnd;
		} else {
			this.previewFocused = false;
		}
		this.onReadingChange?.(next);
	}

	private handleReadingInput(data: string): boolean {
		// Read-only: never select / resume. Esc / z / h leave reading mode.
		if (matchesKey(data, "escape") || data === "z" || data === "h") {
			this.setReading(false);
			return true;
		}
		if (matchesKey(data, "enter")) {
			return true;
		}
		return this.handlePreviewScroll(data);
	}

	private handlePreviewScroll(data: string): boolean {
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this._previewScrollOffset = Math.min(
				this._previewScrollOffset + 1,
				Math.max(0, this.currentPreview.length - 1),
			);
			return true;
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			if (this._previewScrollOffset <= 0) {
				this.requestMoreHistory();
			} else {
				this._previewScrollOffset = Math.max(0, this._previewScrollOffset - 1);
				if (this._previewScrollOffset <= 1) this.requestMoreHistory();
			}
			return true;
		}
		if (matchesKey(data, "g")) {
			this._previewScrollOffset = 0;
			this.requestMoreHistory();
			return true;
		}
		if (matchesKey(data, "shift+g")) {
			this._previewScrollOffset = Math.max(0, this.currentPreview.length - this.lastVisiblePreviewHeight);
			return true;
		}
		return true;
	}

	private renderReading(width: number): string[] {
		const previewWidth = Math.max(1, width);
		this.lastPreviewWidth = previewWidth;
		this.refreshPreview(previewWidth);

		const visiblePreviewHeight = this.readingMaxVisible;
		this.lastVisiblePreviewHeight = visiblePreviewHeight;

		if (this.shouldPinToEnd && this.currentPreview.length > 0) {
			this._previewScrollOffset = Math.max(0, this.currentPreview.length - visiblePreviewHeight);
			this.shouldPinToEnd = false;
		}

		const header = truncateToWidth(
			` READ-ONLY  ${this._selectedItem?.label ?? ""}  j/k scroll  g/G  z/Esc back`,
			previewWidth,
			"…",
		);
		const scrolled = this.currentPreview.slice(
			this._previewScrollOffset,
			this._previewScrollOffset + visiblePreviewHeight,
		);
		const body = scrolled.map((l) => truncateToWidth(l, previewWidth, "…"));
		const lines = [header, ...body];

		if (this.currentPreview.length > visiblePreviewHeight) {
			const indicator = `${this._previewScrollOffset + 1}-${Math.min(this._previewScrollOffset + visiblePreviewHeight, this.currentPreview.length)}/${this.currentPreview.length}`;
			lines.push(truncateToWidth(indicator, previewWidth, "…"));
		}

		return lines;
	}

	private requestMoreHistory(): void {
		if (!this._selectedItem || !this.onPreviewNeedMore) return;
		this.onPreviewNeedMore(this._selectedItem);
	}

	private refreshPreview(previewWidth: number): void {
		if (previewWidth <= 0) {
			this.currentPreview = [];
			return;
		}
		const previousLength = this.currentPreview.length;
		const previousOffset = this._previewScrollOffset;
		this.currentPreview = this.previewFn(this._selectedItem, previewWidth);
		const delta = this.currentPreview.length - previousLength;
		// Expanding older history prepends lines — keep the same viewport.
		if (!this.shouldPinToEnd && delta > 0 && previousLength > 0) {
			this._previewScrollOffset = previousOffset + delta;
		}
	}
}
