import type { Component } from "../component.js";
import { truncateToWidth } from "../utils.js";

export interface DialogAction {
	label: string;
	key: string;
	action: () => void;
}

export interface DialogTheme {
	border: (s: string) => string;
	title: (s: string) => string;
	body: (s: string) => string;
	dim: (s: string) => string;
}

export interface DialogOptions {
	title: string;
	body: string;
	actions: DialogAction[];
	theme: DialogTheme;
}

export class Dialog implements Component {
	private readonly title: string;
	private readonly body: string;
	private readonly actions: DialogAction[];
	private readonly theme: DialogTheme;

	constructor(opts: DialogOptions) {
		this.title = opts.title;
		this.body = opts.body;
		this.actions = opts.actions;
		this.theme = opts.theme;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const { theme } = this;
		const lines: string[] = [];
		const inner = Math.max(10, width - 4);

		lines.push(theme.border("─".repeat(width)));
		lines.push(theme.title(`  ${this.title}`));
		lines.push("");

		for (const line of this.body.split("\n")) {
			lines.push(theme.body(`  ${truncateToWidth(line, inner, "…")}`));
		}

		lines.push("");
		const hints = this.actions.map((a) => `[${a.key}] ${a.label}`).join("  ");
		lines.push(theme.dim(`  ${hints}`));
		lines.push(theme.border("─".repeat(width)));

		return lines;
	}

	handleInput(data: string): boolean {
		for (const action of this.actions) {
			if (data === action.key || data.toLowerCase() === action.key.toLowerCase()) {
				action.action();
				return true;
			}
		}
		if (data === "\x1b") {
			const cancel = this.actions.find((a) => a.key === "n" || a.key === "Esc");
			cancel?.action();
			return true;
		}
		return false;
	}
}
