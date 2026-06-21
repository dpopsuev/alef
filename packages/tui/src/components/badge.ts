import type { Component } from "../component.js";
import { badge as formatBadge } from "../design/typography.js";

export interface BadgeOptions {
	label?: string;
	style?: (s: string) => string;
}

export class Badge implements Component {
	private value = 0;
	private label: string;
	private style: (s: string) => string;

	constructor(opts: BadgeOptions = {}) {
		this.label = opts.label ?? "";
		this.style = opts.style ?? ((s) => s);
	}

	setValue(n: number): void {
		this.value = n;
	}

	invalidate(): void {}

	render(_width: number): string[] {
		const formatted = formatBadge(this.value);
		const text = this.label ? `${this.label}: ${formatted}` : formatted;
		return [this.style(text)];
	}
}
