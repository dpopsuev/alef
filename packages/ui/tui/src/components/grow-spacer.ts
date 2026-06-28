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
	private siblingLines: number;
	private _contentLines = 0;
	private _enabled = true;

	constructor(siblingLines: number) {
		this.siblingLines = siblingLines;
	}

	setSiblingLines(n: number): void {
		this.siblingLines = n;
	}

	setContentLines(n: number): void {
		this._contentLines = n;
	}

	addContentLines(delta: number): void {
		this._contentLines = Math.max(0, this._contentLines + delta);
	}

	setEnabled(enabled: boolean): void {
		this._enabled = enabled;
	}

	invalidate(): void {}

	render(_width: number): string[] {
		if (!this._enabled) return [];
		const rows = process.stdout.rows ?? 24;
		const used = this.siblingLines + this._contentLines;
		if (used >= rows) return [];
		const blank = rows - used;
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Array.fill("") produces string[] but TS infers any[]
		return Array(blank).fill("") as string[];
	}
}
