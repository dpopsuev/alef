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

/**
 *
 */
export interface SeparatorLineOptions {
	weight?: SeparatorWeight;
	label?: string;
	style?: (s: string) => string;
	/** @deprecated Prefer setLeftLabel / setRightLabel. Single-label align when only one side is set. */
	labelAlign?: "left" | "right";
}

/**
 * Full-width rule with optional left and right embedded labels.
 * Lower delimiter: mode (INSERT/NORMAL) left, notices (compacting) right.
 */
export class SeparatorLine implements Component {
	private weight: SeparatorWeight;
	private leftLabel: string;
	private rightLabel: string;
	private style: (s: string) => string;
	private labelAlign: "left" | "right";

	constructor(opts: SeparatorLineOptions = {}) {
		this.weight = opts.weight ?? "thin";
		this.leftLabel = opts.labelAlign === "right" ? "" : (opts.label ?? "");
		this.rightLabel = opts.labelAlign === "right" ? (opts.label ?? "") : "";
		this.style = opts.style ?? ((s) => s);
		this.labelAlign = opts.labelAlign ?? "left";
	}

	/** @deprecated Use setLeftLabel — kept for callers that set a single left label. */
	setLabel(label: string): void {
		if (this.labelAlign === "right") this.rightLabel = label;
		else this.leftLabel = label;
	}

	setLeftLabel(label: string): void {
		this.leftLabel = label;
	}

	setRightLabel(label: string): void {
		this.rightLabel = label;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const char = WEIGHT_CHARS[this.weight];
		const left = this.leftLabel ? ` ${this.leftLabel} ` : "";
		const right = this.rightLabel ? ` ${this.rightLabel} ` : "";
		const leftW = visibleWidth(left);
		const rightW = visibleWidth(right);

		if (!left && !right) return [this.style(char.repeat(width))];

		if (!left && right) {
			const prefixLen = Math.max(0, width - rightW);
			return [this.style(char.repeat(prefixLen)) + right];
		}

		if (left && !right) {
			const prefixLen = 1;
			const suffixLen = Math.max(0, width - prefixLen - leftW);
			return [this.style(char.repeat(prefixLen)) + left + this.style(char.repeat(suffixLen))];
		}

		const fill = Math.max(0, width - 1 - leftW - rightW);
		return [this.style(char.repeat(1)) + left + this.style(char.repeat(fill)) + right];
	}
}
