import type { Component } from "../component.js";
import { visibleWidth } from "../utils.js";

/**
 *
 */
export interface ProgressBarOptions {
	value: number;
	max?: number;
	width?: number;
	label?: string;
	filledChar?: string;
	emptyChar?: string;
	style?: (text: string) => string;
}

/**
 *
 */
export class ProgressBar implements Component {
	private opts: ProgressBarOptions;

	constructor(opts: ProgressBarOptions) {
		this.opts = opts;
	}

	setValue(value: number): void {
		this.opts.value = value;
	}

	setLabel(label: string): void {
		this.opts.label = label;
	}

	invalidate(): void {}

	format(barWidth?: number): string {
		const max = this.opts.max ?? 100;
		const filledChar = this.opts.filledChar ?? "█";
		const emptyChar = this.opts.emptyChar ?? "░";
		const pct = Math.min(1, Math.max(0, this.opts.value / max));
		const w = barWidth ?? this.opts.width ?? 10;
		const filledCount = Math.round(w * pct);
		return filledChar.repeat(filledCount) + emptyChar.repeat(w - filledCount);
	}

	render(width: number): string[] {
		const max = this.opts.max ?? 100;
		const pct = Math.min(1, Math.max(0, this.opts.value / max));
		const pctText = `${Math.round(pct * 100)}%`;
		const label = this.opts.label ? `${this.opts.label} ` : "";
		const labelWidth = visibleWidth(label);
		const pctWidth = visibleWidth(pctText) + 1;
		const barWidth = Math.max(4, (this.opts.width ?? width) - labelWidth - pctWidth);
		const line = `${label}${this.format(barWidth)} ${pctText}`;
		return [this.opts.style ? this.opts.style(line) : line];
	}
}
