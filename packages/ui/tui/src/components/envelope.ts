import type { Component } from "../component.js";
import { BOX } from "../design/chars.js";
import { truncateToWidth, visibleWidth } from "../utils.js";

export interface EnvelopeOptions {
	title: string;
	collapsed?: boolean;
	borderStyle?: "rounded" | "light" | "heavy";
	style?: (s: string) => string;
	titleStyle?: (s: string) => string;
}

export class Envelope implements Component {
	private _collapsed: boolean;
	private title: string;
	private content: Component | null = null;
	private border: (typeof BOX)["rounded"];
	private style: (s: string) => string;
	private titleStyle: (s: string) => string;

	constructor(opts: EnvelopeOptions) {
		this.title = opts.title;
		this._collapsed = opts.collapsed ?? false;
		this.border = BOX[opts.borderStyle ?? "rounded"];
		this.style = opts.style ?? ((s) => s);
		this.titleStyle = opts.titleStyle ?? ((s) => s);
	}

	get collapsed(): boolean {
		return this._collapsed;
	}
	toggle(): void {
		this._collapsed = !this._collapsed;
	}
	setContent(c: Component): void {
		this.content = c;
	}
	setTitle(t: string): void {
		this.title = t;
	}

	invalidate(): void {
		this.content?.invalidate();
	}

	render(width: number): string[] {
		const b = this.border;
		const indicator = this._collapsed ? "▸" : "▾";
		const titleText = truncateToWidth(` ${indicator} ${this.title} `, width - 4, "…");
		const topPad = Math.max(0, width - visibleWidth(titleText) - 2);
		const top = this.style(`${b.topLeft}${this.titleStyle(titleText)}${b.horizontal.repeat(topPad)}${b.topRight}`);

		if (this._collapsed || !this.content) {
			return [top];
		}

		const inner = width - 4;
		const contentLines = this.content.render(inner);
		const lines = [top];
		for (const line of contentLines) {
			const pad = Math.max(0, inner - visibleWidth(line));
			lines.push(this.style(`${b.vertical} ${line}${" ".repeat(pad)} ${b.vertical}`));
		}
		lines.push(this.style(`${b.bottomLeft}${b.horizontal.repeat(width - 2)}${b.bottomRight}`));
		return lines;
	}
}
