import type { Component } from "../component.js";

export interface FlowJunctionOptions {
	type: "split" | "merge";
	branches: number;
	labels?: string[];
	style?: (s: string) => string;
}

export class FlowJunction implements Component {
	private opts: FlowJunctionOptions;

	constructor(opts: FlowJunctionOptions) {
		this.opts = opts;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const apply = this.opts.style ?? ((s: string) => s);
		const n = Math.max(2, Math.min(4, this.opts.branches));
		const spacing = Math.floor(width / (n + 1));

		if (this.opts.type === "split") {
			const center = "        │";
			const arms = Array.from({ length: n }, (_, i) => {
				const pos = spacing * (i + 1);
				return pos;
			});
			const branchLine = Array.from({ length: width }, (_, i) => {
				if (i === 8) return "┼";
				if (arms.includes(i)) return "┬";
				if (i >= Math.min(...arms) && i <= Math.max(...arms)) return "─";
				return " ";
			}).join("");
			const pipes = Array.from({ length: width }, (_, i) => {
				if (arms.includes(i)) return "│";
				return " ";
			}).join("");
			return [apply(center), apply(branchLine), apply(pipes)];
		}

		const arms = Array.from({ length: n }, (_, i) => spacing * (i + 1));
		const pipes = Array.from({ length: width }, (_, i) => {
			if (arms.includes(i)) return "│";
			return " ";
		}).join("");
		const mergeLine = Array.from({ length: width }, (_, i) => {
			if (i === 8) return "┼";
			if (arms.includes(i)) return "┴";
			if (i >= Math.min(...arms) && i <= Math.max(...arms)) return "─";
			return " ";
		}).join("");
		const center = "        │";
		return [apply(pipes), apply(mergeLine), apply(center)];
	}
}
