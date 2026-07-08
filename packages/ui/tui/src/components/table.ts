import type { Component } from "../component.js";
import { truncateToWidth, visibleWidth } from "../utils.js";

/**
 *
 */
export interface TableColumn {
	header: string;
	key: string;
	width?: number;
	align?: "left" | "right";
}

/**
 *
 */
export interface TableOptions {
	columns: TableColumn[];
	rows: Record<string, string>[];
	headerStyle?: (text: string) => string;
	cellStyle?: (text: string, key: string) => string;
}

/**
 *
 */
function padCell(text: string, width: number, align: "left" | "right"): string {
	const w = visibleWidth(text);
	const gap = Math.max(0, width - w);
	return align === "right" ? " ".repeat(gap) + text : text + " ".repeat(gap);
}

/**
 *
 */
export class Table implements Component {
	private opts: TableOptions;

	constructor(opts: TableOptions) {
		this.opts = opts;
	}

	setRows(rows: Record<string, string>[]): void {
		this.opts.rows = rows;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const { columns, rows, headerStyle, cellStyle } = this.opts;
		const gap = 2;

		const colWidths = columns.map((col) => {
			if (col.width) return col.width;
			const headerW = visibleWidth(col.header);
			const maxCellW = rows.reduce((max, row) => Math.max(max, visibleWidth(row[col.key] ?? "")), 0);
			return Math.max(headerW, maxCellW);
		});

		const totalWidth = colWidths.reduce((s, w) => s + w + gap, -gap);
		if (totalWidth > width && colWidths.length > 0) {
			const last = colWidths.length - 1;
			colWidths[last] = Math.max(4, width - (totalWidth - colWidths[last]!));
		}

		const lines: string[] = [];

		const headerLine = columns
			.map((col, i) => {
				const text = truncateToWidth(col.header, colWidths[i]!, "…");
				const padded = padCell(text, colWidths[i]!, col.align ?? "left");
				return headerStyle ? headerStyle(padded) : padded;
			})
			.join(" ".repeat(gap));
		lines.push(headerLine);

		const separator = columns.map((_, i) => "─".repeat(colWidths[i]!)).join(" ".repeat(gap));
		lines.push(separator);

		for (const row of rows) {
			const rowLine = columns
				.map((col, i) => {
					const raw = row[col.key] ?? "";
					const text = truncateToWidth(raw, colWidths[i]!, "…");
					const padded = padCell(text, colWidths[i]!, col.align ?? "left");
					return cellStyle ? cellStyle(padded, col.key) : padded;
				})
				.join(" ".repeat(gap));
			lines.push(rowLine);
		}

		return lines;
	}
}
