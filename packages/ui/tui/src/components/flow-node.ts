import type { Component } from "../component.js";
import { BOX } from "../design/chars.js";
import type { StatusLevel } from "../design/palette.js";
import { statusGlyph } from "../design/palette.js";
import { truncateToWidth, visibleWidth } from "../utils.js";

export interface FlowNodeOptions {
	id: string;
	title: string;
	status: StatusLevel;
	lines?: string[];
	content?: Component;
	badge?: string;
	collapsed?: boolean;
	style?: (s: string) => string;
}

export class FlowNode implements Component {
	private opts: FlowNodeOptions;

	constructor(opts: FlowNodeOptions) {
		this.opts = opts;
	}

	update(opts: Partial<FlowNodeOptions>): void {
		Object.assign(this.opts, opts);
	}

	get id(): string {
		return this.opts.id;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const { title, status, lines, badge, collapsed, style } = this.opts;
		const apply = style ?? ((s: string) => s);
		const glyph = statusGlyph(status);

		if (collapsed ?? false) {
			const badgeSuffix = badge ? `  ${badge}` : "";
			return [apply(`        ${glyph} ${title}${badgeSuffix}`)];
		}

		const b = BOX.rounded;
		const inner = Math.max(20, width - 12);
		const titleText = truncateToWidth(` ${title} `, inner - 2, "…");
		const topPad = Math.max(0, inner - visibleWidth(titleText));
		const result = [apply(`  ${b.topLeft}${b.horizontal}${titleText}${b.horizontal.repeat(topPad)}${b.topRight}`)];

		const contentLines = this.opts.content
			? this.opts.content.render(inner - 2)
			: (lines ?? []).map((line) => ` ${glyph} ${line}`);

		for (const line of contentLines) {
			const padded = truncateToWidth(line, inner, "…");
			const gap = Math.max(0, inner - visibleWidth(padded));
			result.push(apply(`  ${b.vertical}${padded}${" ".repeat(gap)} ${b.vertical}`));
		}

		if (badge) {
			const badgeLine = truncateToWidth(` ${badge}`, inner, "…");
			const gap = Math.max(0, inner - visibleWidth(badgeLine));
			result.push(apply(`  ${b.vertical}${badgeLine}${" ".repeat(gap)} ${b.vertical}`));
		}

		result.push(apply(`  ${b.bottomLeft}${b.horizontal.repeat(inner + 1)}${b.bottomRight}`));
		return result;
	}
}
