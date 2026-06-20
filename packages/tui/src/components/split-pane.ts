import type { Component } from "../component.js";
import { truncateToWidth, visibleWidth } from "../utils.js";

export interface SplitPaneOptions {
	ratio?: number;
	borderChar?: string;
	minLeftWidth?: number;
	minRightWidth?: number;
}

function padLine(line: string, targetWidth: number): string {
	const w = visibleWidth(line);
	return w >= targetWidth ? line : line + " ".repeat(targetWidth - w);
}

export class SplitPane implements Component {
	private left: Component;
	private right: Component;
	private ratio: number;
	private borderChar: string;
	private minLeftWidth: number;
	private minRightWidth: number;

	constructor(left: Component, right: Component, opts: SplitPaneOptions = {}) {
		this.left = left;
		this.right = right;
		this.ratio = opts.ratio ?? 0.5;
		this.borderChar = opts.borderChar ?? "│";
		this.minLeftWidth = opts.minLeftWidth ?? 10;
		this.minRightWidth = opts.minRightWidth ?? 10;
	}

	invalidate(): void {
		this.left.invalidate();
		this.right.invalidate();
	}

	render(width: number): string[] {
		if (width < this.minLeftWidth + this.minRightWidth + 1) {
			return this.left.render(width);
		}

		const leftWidth = Math.max(this.minLeftWidth, Math.floor(width * this.ratio));
		const rightWidth = Math.max(this.minRightWidth, width - leftWidth - 1);

		const leftLines = this.left.render(leftWidth);
		const rightLines = this.right.render(rightWidth);

		const maxLines = Math.max(leftLines.length, rightLines.length);
		const merged: string[] = [];

		for (let i = 0; i < maxLines; i++) {
			const l = padLine(leftLines[i] ?? "", leftWidth);
			const r = truncateToWidth(rightLines[i] ?? "", rightWidth, "…");
			merged.push(`${l}${this.borderChar}${r}`);
		}

		return merged;
	}
}
