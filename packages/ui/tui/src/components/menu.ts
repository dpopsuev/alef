import type { Component } from "../component.js";
import { matchesKey } from "../keys.js";
import { truncateToWidth } from "../utils.js";

/**
 *
 */
export interface MenuItem {
	label: string;
	key?: string;
	description?: string;
	action: () => void;
}

/**
 *
 */
export interface MenuTheme {
	border: (s: string) => string;
	selected: (s: string) => string;
	normal: (s: string) => string;
	dim: (s: string) => string;
	title: (s: string) => string;
}

/**
 *
 */
export interface MenuOptions {
	items: MenuItem[];
	title?: string;
	theme: MenuTheme;
	onClose?: () => void;
}

/**
 *
 */
export class Menu implements Component {
	private selectedIndex = 0;
	private readonly items: MenuItem[];
	private readonly theme: MenuTheme;
	private readonly title: string;
	private readonly onClose?: () => void;

	constructor(opts: MenuOptions) {
		this.items = opts.items;
		this.theme = opts.theme;
		this.title = opts.title ?? "";
		this.onClose = opts.onClose;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const { theme, items, selectedIndex } = this;
		const lines: string[] = [];

		if (this.title) lines.push(theme.title(this.title));
		lines.push(theme.border("─".repeat(width)));

		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			const isSel = i === selectedIndex;
			const prefix = isSel ? "  > " : "    ";
			const keyHint = item.key ? theme.dim(` [${item.key}]`) : "";
			const desc = item.description ? theme.dim(` — ${item.description}`) : "";
			const line = truncateToWidth(`${prefix}${item.label}${keyHint}${desc}`, width, "…");
			lines.push(isSel ? theme.selected(line) : theme.normal(line));
		}

		lines.push(theme.border("─".repeat(width)));
		return lines;
	}

	handleInput(data: string): boolean {
		if (matchesKey(data, "down") || data === "j") {
			this.selectedIndex = (this.selectedIndex + 1) % this.items.length;
			return true;
		}
		if (matchesKey(data, "up") || data === "k") {
			this.selectedIndex = (this.selectedIndex - 1 + this.items.length) % this.items.length;
			return true;
		}
		if (data === "\r") {
			this.items[this.selectedIndex]?.action();
			return true;
		}
		if (data === "\x1b" || data === "q") {
			this.onClose?.();
			return true;
		}
		for (const item of this.items) {
			if (item.key && data === item.key) {
				item.action();
				return true;
			}
		}
		return false;
	}
}
