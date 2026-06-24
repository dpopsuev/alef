import type { Component } from "../component.js";

export interface FlowLoopOptions {
	span: number;
	label?: string;
	style?: (s: string) => string;
}

export class FlowLoop implements Component {
	private opts: FlowLoopOptions;

	constructor(opts: FlowLoopOptions) {
		this.opts = opts;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const apply = this.opts.style ?? ((s: string) => s);
		const rightCol = Math.min(width - 2, 40);
		const label = this.opts.label ?? "retry";

		const lines: string[] = [];
		lines.push(apply(`${" ".repeat(rightCol)}╮`));
		for (let i = 0; i < this.opts.span; i++) {
			if (i === Math.floor(this.opts.span / 2)) {
				lines.push(apply(`${" ".repeat(rightCol)}│ ${label}`));
			} else {
				lines.push(apply(`${" ".repeat(rightCol)}│`));
			}
		}
		lines.push(apply(`${" ".repeat(rightCol)}╯`));
		return lines;
	}
}
