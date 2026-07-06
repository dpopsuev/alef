import type { Component } from "../component.js";
import { truncateToWidth, visibleWidth } from "../utils.js";

/**
 *
 */
export type BorderStyle = "single" | "double" | "rounded" | "none";

/**
 *
 */
export interface BoxOptions {
	border?: BorderStyle;
	title?: string;
	paddingX?: number;
	paddingY?: number;
}

const BORDERS = {
	single: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
	double: { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" },
	rounded: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
	none: { tl: " ", tr: " ", bl: " ", br: " ", h: " ", v: " " },
};

/**
 *
 */
export class Box implements Component {
	private child: Component;
	private opts: Required<BoxOptions>;

	constructor(child: Component, opts: BoxOptions = {}) {
		this.child = child;
		this.opts = {
			border: opts.border ?? "single",
			title: opts.title ?? "",
			paddingX: opts.paddingX ?? 1,
			paddingY: opts.paddingY ?? 0,
		};
	}

	invalidate(): void {
		this.child.invalidate();
	}

	render(width: number): string[] {
		const b = BORDERS[this.opts.border];
		const innerWidth = Math.max(1, width - 2 - this.opts.paddingX * 2);
		const childLines = this.child.render(innerWidth);
		const pad = " ".repeat(this.opts.paddingX);
		const lines: string[] = [];

		// Top border
		let top = `${b.tl}${b.h.repeat(width - 2)}${b.tr}`;
		if (this.opts.title) {
			const title = ` ${this.opts.title} `;
			const titleTrunc = truncateToWidth(title, width - 4, "…");
			top = `${b.tl}${titleTrunc}${b.h.repeat(Math.max(0, width - 2 - visibleWidth(titleTrunc)))}${b.tr}`;
		}
		lines.push(top);

		// Top padding
		for (let i = 0; i < this.opts.paddingY; i++) {
			lines.push(`${b.v}${" ".repeat(width - 2)}${b.v}`);
		}

		// Content
		for (const line of childLines) {
			const content = truncateToWidth(line, innerWidth, "…");
			const fill = " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
			lines.push(`${b.v}${pad}${content}${fill}${pad}${b.v}`);
		}

		// Bottom padding
		for (let i = 0; i < this.opts.paddingY; i++) {
			lines.push(`${b.v}${" ".repeat(width - 2)}${b.v}`);
		}

		// Bottom border
		lines.push(`${b.bl}${b.h.repeat(width - 2)}${b.br}`);

		return lines;
	}
}
