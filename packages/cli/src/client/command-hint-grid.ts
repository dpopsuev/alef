import type { Component } from "@dpopsuev/alef-tui";
import { fuzzyFilter, truncateToWidth, visibleWidth } from "@dpopsuev/alef-tui";

export interface CommandHint {
	name: string;
	description: string;
}

export interface CommandHintGridOptions {
	commands: CommandHint[];
	columns?: number;
	style?: (text: string) => string;
	activeStyle?: (text: string) => string;
}

export class CommandHintGrid implements Component {
	private commands: CommandHint[];
	private filtered: CommandHint[];
	private columns: number;
	private style: (text: string) => string;
	private activeStyle: (text: string) => string;
	private visible = false;

	constructor(opts: CommandHintGridOptions) {
		this.commands = opts.commands;
		this.filtered = opts.commands;
		this.columns = opts.columns ?? 4;
		this.style = opts.style ?? ((s) => s);
		this.activeStyle = opts.activeStyle ?? ((s) => s);
	}

	setFilter(query: string): void {
		if (!query) {
			this.filtered = this.commands;
		} else {
			this.filtered = fuzzyFilter(this.commands, query, (c) => `${c.name} ${c.description}`);
		}
	}

	show(): void {
		this.visible = true;
	}

	hide(): void {
		this.visible = false;
		this.filtered = this.commands;
	}

	get isVisible(): boolean {
		return this.visible;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (!this.visible || this.filtered.length === 0) return [];

		const items = this.filtered;
		const showDesc = items.length <= 6;
		const cols = Math.min(this.columns, Math.max(1, Math.floor(width / 20)));

		const rows: string[] = [];
		for (let i = 0; i < items.length; i += cols) {
			const chunk = items.slice(i, i + cols);
			const colWidth = Math.floor(width / cols);

			const cells = chunk.map((cmd) => {
				const prefix = `:${cmd.name}`;
				if (showDesc && cmd.description) {
					const desc = cmd.description.split("—")[0]?.trim().split(" ").slice(0, 3).join(" ") ?? "";
					const full = `${prefix} ${desc}`;
					return truncateToWidth(full, colWidth - 1, "…");
				}
				return truncateToWidth(prefix, colWidth - 1, "…");
			});

			const line = cells
				.map((cell) => {
					const pad = Math.max(0, Math.floor(width / cols) - visibleWidth(cell));
					return cell + " ".repeat(pad);
				})
				.join("");

			rows.push(this.style(line));
		}

		return rows;
	}
}
