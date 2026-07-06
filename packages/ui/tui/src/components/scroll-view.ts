import type { Component } from "../component.js";
import { truncateToWidth } from "../utils.js";

/**
 *
 */
export interface ScrollViewOptions {
	maxHeight?: number;
	showScrollbar?: boolean;
}

/**
 *
 */
export class ScrollView implements Component {
	private child: Component;
	private scrollOffset = 0;
	private maxHeight: number;
	private showScrollbar: boolean;

	constructor(child: Component, opts: ScrollViewOptions = {}) {
		this.child = child;
		this.maxHeight = opts.maxHeight ?? 20;
		this.showScrollbar = opts.showScrollbar ?? true;
	}

	scrollDown(n = 1): void {
		this.scrollOffset += n;
	}

	scrollUp(n = 1): void {
		this.scrollOffset = Math.max(0, this.scrollOffset - n);
	}

	scrollToTop(): void {
		this.scrollOffset = 0;
	}

	scrollToBottom(): void {
		this.scrollOffset = Number.MAX_SAFE_INTEGER;
	}

	invalidate(): void {
		this.child.invalidate();
		this.scrollOffset = 0;
	}

	handleInput(data: string): boolean {
		if (data === "j" || data === "\x1b[B") {
			this.scrollDown();
			return true;
		}
		if (data === "k" || data === "\x1b[A") {
			this.scrollUp();
			return true;
		}
		if (data === "g") {
			this.scrollToTop();
			return true;
		}
		if (data === "G") {
			this.scrollToBottom();
			return true;
		}
		return false;
	}

	render(width: number): string[] {
		const allLines = this.child.render(this.showScrollbar ? width - 1 : width);
		const totalLines = allLines.length;

		if (totalLines <= this.maxHeight) {
			this.scrollOffset = 0;
			return this.showScrollbar ? allLines.map((l) => `${l} `) : allLines;
		}

		const maxOffset = Math.max(0, totalLines - this.maxHeight);
		this.scrollOffset = Math.min(this.scrollOffset, maxOffset);

		const visible = allLines.slice(this.scrollOffset, this.scrollOffset + this.maxHeight);

		if (!this.showScrollbar) return visible;

		const thumbSize = Math.max(1, Math.round((this.maxHeight / totalLines) * this.maxHeight));
		const thumbStart = Math.round((this.scrollOffset / maxOffset) * (this.maxHeight - thumbSize));

		return visible.map((line, i) => {
			const inThumb = i >= thumbStart && i < thumbStart + thumbSize;
			return `${truncateToWidth(line, width - 1, "…")}${inThumb ? "█" : "░"}`;
		});
	}
}
