import type { Component } from "../component.js";
import { visibleWidth } from "../utils.js";

export interface ProgressBarOptions {
	value: number;
	max?: number;
	width?: number;
	label?: string;
	filledChar?: string;
	emptyChar?: string;
	style?: (text: string) => string;
}

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

	render(width: number): string[] {
		const max = this.opts.max ?? 100;
		const filled = this.opts.filledChar ?? "█";
		const empty = this.opts.emptyChar ?? "░";
		const pct = Math.min(1, Math.max(0, this.opts.value / max));
		const pctText = `${Math.round(pct * 100)}%`;

		const label = this.opts.label ? `${this.opts.label} ` : "";
		const labelWidth = visibleWidth(label);
		const pctWidth = visibleWidth(pctText) + 1;
		const barWidth = Math.max(4, (this.opts.width ?? width) - labelWidth - pctWidth);

		const filledCount = Math.round(barWidth * pct);
		const bar = filled.repeat(filledCount) + empty.repeat(barWidth - filledCount);

		const line = `${label}${bar} ${pctText}`;
		return [this.opts.style ? this.opts.style(line) : line];
	}
}
