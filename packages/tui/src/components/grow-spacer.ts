import type { Component } from "../component.js";

/**
 * GrowSpacer fills available vertical space so content below it anchors to
 * the bottom of the terminal.
 *
 * Pass a `contentLines` getter that returns the current line count of the
 * content below the spacer. The spacer renders:
 *   max(0, terminalRows - fixedLines - contentLines())
 * blank lines, pushing the content to the bottom.
 *
 * Update contentLines by calling setContentLines() whenever content changes.
 */
export class GrowSpacer implements Component {
	private fixedLines: number;
	private _contentLines = 0;

	constructor(fixedLines: number) {
		this.fixedLines = fixedLines;
	}

	setContentLines(n: number): void {
		this._contentLines = n;
	}

	addContentLines(delta: number): void {
		this._contentLines = Math.max(0, this._contentLines + delta);
	}

	invalidate(): void {}

	render(_width: number): string[] {
		const rows = process.stdout.rows ?? 24;
		const blank = Math.max(0, rows - this.fixedLines - this._contentLines);
		return Array(blank).fill("") as string[];
	}
}
