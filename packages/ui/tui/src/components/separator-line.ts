import type { Component } from "../component.js";
import { SEPARATOR } from "../design/chars.js";
import type { SeparatorWeight } from "../design/typography.js";
import { visibleWidth } from "../utils.js";

const WEIGHT_CHARS: Record<SeparatorWeight, string> = {
	thick: SEPARATOR.thick,
	thin: SEPARATOR.thin,
	dotted: SEPARATOR.dotted,
	dashed: SEPARATOR.dashed,
};

export interface SeparatorLineOptions {
	weight?: SeparatorWeight;
	label?: string;
	style?: (s: string) => string;
}

export class SeparatorLine implements Component {
	private weight: SeparatorWeight;
	private label: string;
	private style: (s: string) => string;

	constructor(opts: SeparatorLineOptions = {}) {
		this.weight = opts.weight ?? "thin";
		this.label = opts.label ?? "";
		this.style = opts.style ?? ((s) => s);
	}

	setLabel(label: string): void {
		this.label = label;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const char = WEIGHT_CHARS[this.weight];
		const fullLine = char.repeat(width);
		if (!this.label) return [this.style(fullLine)];
		const text = ` ${this.label} `;
		const labelWidth = visibleWidth(text);
		const prefixLen = 1;
		const suffixLen = Math.max(0, width - prefixLen - labelWidth);
		return [this.style(char.repeat(prefixLen)) + text + this.style(char.repeat(suffixLen))];
	}
}
