/**
 * Grid capture -- snapshot the terminal viewport as a 2D cell grid.
 *
 * The viewport is a fixed rows x cols grid where each cell has:
 *   - char: the visible character (empty string for blank)
 *   - attr: the xterm attribute bitmask (encodes fg, bg, bold, italic, etc.)
 *
 * Scrollback is captured as an ordered list of lines (text only).
 *
 * Grid diffing detects:
 *   - Wasteful repaint: cell content identical before/after but bytes were emitted
 *   - Content change: cell differs between snapshots
 *   - Blank cell: cell that was non-empty and became empty
 */

import type { Terminal as XtermTerminalType } from "@xterm/headless";
import type { VirtualTerminal } from "./virtual-terminal.js";

// ---------------------------------------------------------------------------
// Cell and Grid types
// ---------------------------------------------------------------------------

export interface Cell {
	/** Visible character. Empty string = blank cell. */
	char: string;
	/** Foreground color mode + value, packed as mode*0x1000000+color. */
	fg: number;
	/** Background color mode + value, packed as mode*0x1000000+color. */
	bg: number;
	/** Style flags: bold|italic|underline|dim packed as bitmask. */
	style: number;
}

export interface GridSnapshot {
	/** rows x cols cell grid (row-major). */
	cells: Cell[][];
	/** Terminal dimensions at capture time. */
	rows: number;
	cols: number;
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/** Access the underlying xterm instance from a VirtualTerminal (test-only). */
function getXterm(vt: VirtualTerminal): XtermTerminalType {
	return (vt as unknown as { xterm: XtermTerminalType }).xterm;
}

/** Capture the current viewport as a cell grid. Call after flush(). */
export function captureGrid(terminal: VirtualTerminal): GridSnapshot {
	const xterm = getXterm(terminal);
	const buf = xterm.buffer.active;
	const rows = xterm.rows;
	const cols = xterm.cols;
	const cells: Cell[][] = [];

	for (let r = 0; r < rows; r++) {
		const line = buf.getLine(buf.viewportY + r);
		const row: Cell[] = [];
		if (line) {
			for (let c = 0; c < cols; c++) {
				const cell = line.getCell(c);
				if (cell) {
					row.push({
						char: cell.getChars(),
						fg: cell.getFgColorMode() * 0x1000000 + cell.getFgColor(),
						bg: cell.getBgColorMode() * 0x1000000 + cell.getBgColor(),
						style: (cell.isBold() ? 1 : 0) | (cell.isItalic() ? 2 : 0) | (cell.isUnderline() ? 4 : 0) | (cell.isDim() ? 8 : 0),
					});
				} else {
					row.push({ char: "", fg: 0, bg: 0, style: 0 });
				}
			}
		} else {
			for (let c = 0; c < cols; c++) {
				row.push({ char: "", fg: 0, bg: 0, style: 0 });
			}
		}
		cells.push(row);
	}

	return { cells, rows, cols };
}

/** Capture scrollback lines above the viewport (text only). */
export function captureScrollback(terminal: VirtualTerminal): string[] {
	const xterm = getXterm(terminal);
	const buf = xterm.buffer.active;
	const lines: string[] = [];
	for (let i = 0; i < buf.viewportY; i++) {
		const line = buf.getLine(i);
		lines.push(line ? line.translateToString(true) : "");
	}
	return lines;
}

// ---------------------------------------------------------------------------
// Grid diffing
// ---------------------------------------------------------------------------

export interface CellDiff {
	row: number;
	col: number;
	before: Cell;
	after: Cell;
}

export interface GridDiff {
	/** Cells that changed content or attributes. */
	changed: CellDiff[];
	/** Cells that went from non-empty to blank (potential flash). */
	blanked: CellDiff[];
	/** Number of cells that are identical in both grids. */
	unchanged: number;
	/** Total cells compared. */
	total: number;
}

/** Diff two grid snapshots cell-by-cell. Dimensions must match. */
export function diffGrids(before: GridSnapshot, after: GridSnapshot): GridDiff {
	if (before.rows !== after.rows || before.cols !== after.cols) {
		throw new Error(
			`Grid dimensions differ: ${before.rows}x${before.cols} vs ${after.rows}x${after.cols}`,
		);
	}

	const changed: CellDiff[] = [];
	const blanked: CellDiff[] = [];
	let unchanged = 0;
	const total = before.rows * before.cols;

	for (let r = 0; r < before.rows; r++) {
		for (let c = 0; c < before.cols; c++) {
			const b = before.cells[r]![c]!;
			const a = after.cells[r]![c]!;
			if (b.char === a.char && b.fg === a.fg && b.bg === a.bg && b.style === a.style) {
				unchanged++;
			} else {
				changed.push({ row: r, col: c, before: b, after: a });
				if (b.char !== "" && a.char === "") {
					blanked.push({ row: r, col: c, before: b, after: a });
				}
			}
		}
	}

	return { changed, blanked, unchanged, total };
}

// ---------------------------------------------------------------------------
// Row-level helpers
// ---------------------------------------------------------------------------

/** Get visible text for a grid row (trimmed trailing spaces). */
export function gridRowText(grid: GridSnapshot, row: number): string {
	return grid.cells[row]!.map((c) => c.char || " ").join("").trimEnd();
}

/** Get all visible text lines from a grid. */
export function gridToText(grid: GridSnapshot): string[] {
	const lines: string[] = [];
	for (let r = 0; r < grid.rows; r++) {
		lines.push(gridRowText(grid, r));
	}
	return lines;
}

/** Identify which rows changed between two grids. Returns 0-based row indices. */
export function changedRows(before: GridSnapshot, after: GridSnapshot): number[] {
	const rows: number[] = [];
	for (let r = 0; r < before.rows; r++) {
		for (let c = 0; c < before.cols; c++) {
			const b = before.cells[r]![c]!;
			const a = after.cells[r]![c]!;
			if (b.char !== a.char || b.fg !== a.fg || b.bg !== a.bg || b.style !== a.style) {
				rows.push(r);
				break;
			}
		}
	}
	return rows;
}

// ---------------------------------------------------------------------------
// Diagnostic formatting
// ---------------------------------------------------------------------------

export function formatGridDiff(diff: GridDiff, before: GridSnapshot, after: GridSnapshot): string {
	const lines: string[] = [];
	lines.push(`Grid diff: ${diff.changed.length} cells changed, ${diff.blanked.length} blanked, ${diff.unchanged}/${diff.total} unchanged`);

	const rows = changedRows(before, after);
	lines.push(`Changed rows: [${rows.join(", ")}]`);

	for (const r of rows) {
		const beforeText = gridRowText(before, r);
		const afterText = gridRowText(after, r);
		lines.push(`  row ${r}: "${beforeText}" -> "${afterText}"`);
	}

	if (diff.blanked.length > 0) {
		lines.push(`Blanked cells (potential flash):`);
		for (const b of diff.blanked.slice(0, 10)) {
			lines.push(`  [${b.row},${b.col}]: "${b.before.char}" -> blank`);
		}
		if (diff.blanked.length > 10) {
			lines.push(`  ... and ${diff.blanked.length - 10} more`);
		}
	}

	return lines.join("\n");
}
