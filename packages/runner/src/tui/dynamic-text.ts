import type { Component } from "@dpopsuev/alef-tui";

export class DynamicText implements Component {
	private fn: (width: number) => string;
	constructor(fn: (width: number) => string) {
		this.fn = fn;
	}
	render(width: number): string[] {
		return this.fn(width).split("\n");
	}
	invalidate(): void {}
}
