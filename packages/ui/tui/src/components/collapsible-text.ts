import type { Component } from "../component.js";
import { wrapTextWithAnsi } from "../utils.js";

const DEFAULT_COLLAPSED_LINES = 5;

/**
 *
 */
export interface CollapsibleTextOptions {
	text: string;
	paddingX?: number;
	collapsedLines?: number;
	headerStyle?: (s: string) => string;
	textStyle?: (s: string) => string;
}

/**
 * Collapsible text block for long tool output (e.g. shell.exec).
 *
 * Short output (<=collapsedLines) renders inline -- no chrome.
 * Long output renders collapsed showing the first N lines with an
 * expand/collapse toggle header showing the total line count.
 */
export class CollapsibleText implements Component {
	private _collapsed = true;
	private readonly lines: string[];
	private readonly collapsedLines: number;
	private readonly paddingX: number;
	private readonly headerStyle: (s: string) => string;
	private readonly textStyle: (s: string) => string;

	constructor(opts: CollapsibleTextOptions) {
		this.lines = opts.text.split("\n");
		this.collapsedLines = opts.collapsedLines ?? DEFAULT_COLLAPSED_LINES;
		this.paddingX = opts.paddingX ?? 0;
		this.headerStyle = opts.headerStyle ?? ((s) => s);
		this.textStyle = opts.textStyle ?? ((s) => s);
	}

	get collapsed(): boolean {
		return this._collapsed;
	}

	get isLong(): boolean {
		return this.lines.length > this.collapsedLines;
	}

	get lineCount(): number {
		return this.lines.length;
	}

	toggle(): void {
		this._collapsed = !this._collapsed;
	}

	expand(): void {
		this._collapsed = false;
	}

	collapse(): void {
		this._collapsed = true;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const pad = " ".repeat(this.paddingX);
		const contentWidth = Math.max(1, width - this.paddingX);

		if (!this.isLong) {
			return this.renderLines(this.lines, pad, contentWidth);
		}

		const indicator = this._collapsed ? "\u25b8" : "\u25be";
		const hidden = this.lines.length - this.collapsedLines;
		const summary = this._collapsed
			? `${indicator} ${this.lines.length} lines (+${hidden} hidden)`
			: `${indicator} ${this.lines.length} lines`;
		const headerLine = pad + this.headerStyle(summary);

		const visible = this._collapsed ? this.lines.slice(0, this.collapsedLines) : this.lines;
		return [headerLine, ...this.renderLines(visible, pad, contentWidth)];
	}

	private renderLines(lines: string[], pad: string, contentWidth: number): string[] {
		const out: string[] = [];
		for (const line of lines) {
			const styled = this.textStyle(line);
			const wrapped = wrapTextWithAnsi(styled, contentWidth);
			for (const segment of wrapped.length > 0 ? wrapped : [""]) {
				out.push(pad + segment);
			}
		}
		return out;
	}
}
