import type { Component } from "../component.js";

/**
 *
 */
export interface FlowEdgeOptions {
	label?: string;
	direction?: "down" | "up";
	style?: (s: string) => string;
}

/**
 *
 */
export class FlowEdge implements Component {
	private opts: FlowEdgeOptions;

	constructor(opts: FlowEdgeOptions = {}) {
		this.opts = opts;
	}

	invalidate(): void {}

	render(_width: number): string[] {
		const apply = this.opts.style ?? ((s: string) => s);
		const pipe = "        │";
		if (this.opts.label) {
			return [apply(pipe), apply(`        │ ${this.opts.label}`), apply(pipe)];
		}
		return [apply(pipe)];
	}
}
