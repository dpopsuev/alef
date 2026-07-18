import type { Component } from "../component.js";
import { SEPARATOR } from "../design/chars.js";
import type { SeparatorWeight } from "../design/typography.js";
import { truncateToWidth, visibleWidth } from "../utils.js";

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
 * Upper delimiter: topic title right — always keeps a corner dash on each end.
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
		if (width <= 0) return [""];
		const char = WEIGHT_CHARS[this.weight];
		const pad = (label: string): string => (label ? ` ${label} ` : "");

		let left = pad(this.leftLabel);
		let right = pad(this.rightLabel);
		let leftW = visibleWidth(left);
		let rightW = visibleWidth(right);

		if (!left && !right) return [this.style(char.repeat(width))];

		// Always reserve one rule cell on each used corner so labels never flush the edge.
		if (!left && right) {
			if (width < 2) return [this.style(char.repeat(width))];
			right = this.fitPaddedLabel(this.rightLabel, width - 2);
			rightW = visibleWidth(right);
			const prefixLen = width - rightW - 1;
			return [this.style(char.repeat(prefixLen)) + right + this.style(char.repeat(1))];
		}

		if (left && !right) {
			if (width < 2) return [this.style(char.repeat(width))];
			left = this.fitPaddedLabel(this.leftLabel, width - 2);
			leftW = visibleWidth(left);
			const suffixLen = width - 1 - leftW;
			return [this.style(char.repeat(1)) + left + this.style(char.repeat(suffixLen))];
		}

		const corners = 2;
		const budget = Math.max(0, width - corners);
		if (leftW + rightW > budget) {
			const leftBudget = Math.min(leftW, Math.max(0, Math.floor(budget / 2)));
			const rightBudget = Math.max(0, budget - leftBudget);
			left = this.fitPaddedLabel(this.leftLabel, leftBudget);
			right = this.fitPaddedLabel(this.rightLabel, rightBudget);
			leftW = visibleWidth(left);
			rightW = visibleWidth(right);
		}
		const fill = Math.max(0, width - 1 - leftW - rightW - 1);
		return [
			this.style(char.repeat(1)) + left + this.style(char.repeat(fill)) + right + this.style(char.repeat(1)),
		];
	}

	private fitPaddedLabel(label: string, maxPaddedWidth: number): string {
		if (!label || maxPaddedWidth <= 0) return "";
		if (maxPaddedWidth < 3) return truncateToWidth(label, maxPaddedWidth, "…");
		const innerMax = maxPaddedWidth - 2;
		const inner = truncateToWidth(label, innerMax, "…");
		return inner ? ` ${inner} ` : "";
	}
}
