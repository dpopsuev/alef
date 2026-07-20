/**
 * Flicker test harness -- analyzes raw ANSI byte streams and 2D cell grids.
 *
 * Two layers of analysis:
 *   Byte-stream: counts escape sequences to locate the root cause
 *   Grid: diffs the rendered cell matrix to detect the visible symptom
 *
 * Testable root causes of terminal flicker:
 *   RC-1: Erase-line (\x1b[2K) on unchanged rows
 *   RC-2: Full viewport clear (\x1b[2J) during incremental updates
 *   RC-3: Missing DEC 2026 synchronized output brackets
 *   RC-4: Cursor visible during movement (hide must precede any CUP/CUU/CUD)
 *   RC-5: Disproportionate byte volume (diff frame as large as full frame)
 *
 * Every assertion embeds a diagnostic block showing render path, erased rows,
 * grid diff, and raw ANSI in the failure message.
 */

import type { FrameRecord } from "./capturing-terminal.js";
import { CapturingTerminal } from "./capturing-terminal.js";
import {
	type GridSnapshot,
	captureGrid,
	captureScrollback,
	changedRows,
	diffGrids,
	formatGridDiff,
	gridToText,
} from "./grid-capture.js";
import type { RenderMeta } from "../src/component.js";
import { Text } from "../src/components/text.js";
import { Container, TUI } from "../src/tui.js";
import { DynamicText } from "../src/views/index.js";
import { expect } from "vitest";

// ---------------------------------------------------------------------------
// ANSI regex catalog
// ---------------------------------------------------------------------------

const RE_ERASE_LINE = /\x1b\[2K/g;
const RE_CLEAR_SCREEN = /\x1b\[2J/;
const RE_CURSOR_HIDE = /\x1b\[\?25l/;
const RE_CURSOR_ABS = /\x1b\[(\d+);(\d+)H/g;
const RE_CURSOR_UP = /\x1b\[(\d+)A/g;
const RE_CURSOR_DOWN = /\x1b\[(\d+)B/g;
const RE_CURSOR_HOME = /\x1b\[H/;
const RE_SYNC_BEGIN = /\x1b\[\?2026h/;
const RE_SYNC_END = /\x1b\[\?2026l/;

// ---------------------------------------------------------------------------
// Per-frame analysis (byte-stream layer)
// ---------------------------------------------------------------------------

export interface FlickerFrameAnalysis {
	/** Original FrameRecord from CapturingTerminal. */
	frame: FrameRecord;
	/** Number of \x1b[2K (erase-line) sequences. */
	eraseLineCount: number;
	/** 1-based row numbers targeted by \x1b[row;colH. */
	absolutePositions: number[];
	/** Frame contains \x1b[2J (full viewport clear). */
	hasClearScreen: boolean;
	/** Wrapped in \x1b[?2026h ... \x1b[?2026l. */
	hasSyncBrackets: boolean;
	/** \x1b[?25l appeared before first cursor movement. */
	cursorHiddenBeforeMove: boolean;
	/** Raw byte count. */
	byteCount: number;
	/** Captured TUI renderMeta at time of this frame. */
	renderMeta: RenderMeta | undefined;
	/** Logical frame lines captured via onRender. */
	logicalLines: string[] | undefined;
}

export function analyzeFlickerFrame(
	frame: FrameRecord,
	meta?: RenderMeta,
	logicalLines?: string[],
): FlickerFrameAnalysis {
	const raw = frame.raw;
	const eraseMatches = raw.match(RE_ERASE_LINE);
	const absPositions: number[] = [];
	const absRe = new RegExp(RE_CURSOR_ABS.source, "g");
	let m: RegExpExecArray | null;
	while ((m = absRe.exec(raw)) !== null) {
		absPositions.push(Number(m[1]));
	}

	const hideIdx = raw.search(RE_CURSOR_HIDE);
	const firstMoveIdx = Math.min(
		...[RE_CURSOR_ABS, RE_CURSOR_UP, RE_CURSOR_DOWN, RE_CURSOR_HOME].map((re) => {
			const idx = raw.search(re);
			return idx === -1 ? Infinity : idx;
		}),
	);

	return {
		frame,
		eraseLineCount: eraseMatches ? eraseMatches.length : 0,
		absolutePositions: absPositions,
		hasClearScreen: RE_CLEAR_SCREEN.test(raw),
		hasSyncBrackets: RE_SYNC_BEGIN.test(raw) && RE_SYNC_END.test(raw),
		cursorHiddenBeforeMove: hideIdx !== -1 && (firstMoveIdx === Infinity || hideIdx < firstMoveIdx),
		byteCount: raw.length,
		renderMeta: meta,
		logicalLines,
	};
}

// ---------------------------------------------------------------------------
// Diagnostic formatting
// ---------------------------------------------------------------------------

function escapeAnsi(raw: string): string {
	return raw
		.replace(/\x1b/g, "\\e")
		.replace(/\r/g, "\\r")
		.replace(/\n/g, "\\n");
}

function formatFrameDiag(a: FlickerFrameAnalysis, index: number): string {
	const lines: string[] = [];
	lines.push(`--- frame ${index} ---`);
	if (a.renderMeta) {
		lines.push(`  renderPath:   ${a.renderMeta.renderPath}`);
		lines.push(`  firstChanged: ${a.renderMeta.firstChanged}`);
		lines.push(`  totalLines:   ${a.renderMeta.totalLines}`);
		lines.push(`  height:       ${a.renderMeta.height}`);
	}
	lines.push(`  eraseLines:   ${a.eraseLineCount}`);
	lines.push(`  absPositions: [${a.absolutePositions.join(", ")}]`);
	lines.push(`  clearScreen:  ${a.hasClearScreen}`);
	lines.push(`  syncBrackets: ${a.hasSyncBrackets}`);
	lines.push(`  cursorHidden: ${a.cursorHiddenBeforeMove}`);
	lines.push(`  bytes:        ${a.byteCount}`);
	const maxRaw = 300;
	const escaped = escapeAnsi(a.frame.raw);
	lines.push(`  raw: ${escaped.length > maxRaw ? `${escaped.slice(0, maxRaw)}...` : escaped}`);
	return lines.join("\n");
}

function formatMultiFrameDiag(frames: FlickerFrameAnalysis[], label: string): string {
	const header = `\n[flicker diagnostic: ${label}]`;
	const body = frames.map((f, i) => formatFrameDiag(f, i)).join("\n");
	return `${header}\n${body}`;
}

function formatGridContext(before: GridSnapshot, after: GridSnapshot): string {
	const diff = diffGrids(before, after);
	return `\n[grid]\n${formatGridDiff(diff, before, after)}`;
}

// ---------------------------------------------------------------------------
// FlickerEnv -- test environment with byte-stream + grid assertions
// ---------------------------------------------------------------------------

export interface FlickerTestEnv {
	terminal: CapturingTerminal;
	tui: TUI;

	/** Wait for render pipeline to settle. */
	settle: (ms?: number) => Promise<void>;
	/** Clear capture state (call before the frames you want to analyze). */
	clearLog: () => void;

	// -- Byte-stream accessors --

	/** Frame records since last clearLog(). */
	frames: () => FrameRecord[];
	/** FlickerFrameAnalysis for each frame since last clearLog(). */
	analyzed: () => FlickerFrameAnalysis[];
	/** Count of \x1b[2K since last clearLog(). */
	eraseLineCount: () => number;
	/** Total raw bytes since last clearLog(). */
	byteCount: () => number;

	// -- Byte-stream assertions --

	/** RC-1: assert eraseLineCount === expected. */
	assertEraseLines: (expected: number, label?: string) => void;
	/** RC-1: assert eraseLineCount <= max for every frame individually. */
	assertMaxEraseLinesPerFrame: (max: number, label?: string) => void;
	/** RC-2: assert no frame contains \x1b[2J. */
	assertNoClearScreen: (label?: string) => void;
	/** RC-3: assert every frame has DEC 2026 brackets. */
	assertSyncBrackets: (label?: string) => void;
	/** RC-4: assert cursor hidden before movement in every frame. */
	assertCursorHidden: (label?: string) => void;
	/** RC-5: assert total bytes < threshold. */
	assertBytesBelow: (threshold: number, label?: string) => void;
	/** Assert no frame rewrites content that matches the given text. */
	assertContentNotRewritten: (text: string, label?: string) => void;
	/** Assert renderPath for the latest frame. */
	assertRenderPath: (expected: RenderMeta["renderPath"], label?: string) => void;

	// -- Grid (2D cell) layer --

	/** Capture current viewport as a cell grid. Flushes pending writes first. */
	captureGrid: () => Promise<GridSnapshot>;
	/** Capture scrollback lines above the viewport. */
	captureScrollback: () => Promise<string[]>;
	/** Assert viewport text matches expected lines (trailing spaces ignored). */
	assertViewport: (expected: string[], label?: string) => Promise<void>;
	/** Assert only the given 0-based rows changed between two grid snapshots. */
	assertChangedRows: (before: GridSnapshot, after: GridSnapshot, expectedRows: number[], label?: string) => void;
	/** Assert no cells were blanked (content -> empty) between two snapshots. */
	assertNoBlanking: (before: GridSnapshot, after: GridSnapshot, label?: string) => void;
	/** Assert grid is identical (zero cell changes) between two snapshots. */
	assertGridUnchanged: (before: GridSnapshot, after: GridSnapshot, label?: string) => void;
}

export function createFlickerEnv(cols = 40, rows = 8): FlickerTestEnv {
	const terminal = new CapturingTerminal(cols, rows);
	const tui = new TUI(terminal);

	const capturedMetas: RenderMeta[] = [];
	const capturedLogical: string[][] = [];
	tui.onRender = (frame) => {
		capturedMetas.push({ ...tui.renderMeta });
		capturedLogical.push(frame.split("\n"));
	};

	terminal.start(
		() => {},
		() => {},
	);
	tui.start();

	let metaOffset = 0;

	const settle = async (ms = 30): Promise<void> => {
		await new Promise<void>((r) => process.nextTick(r));
		await new Promise<void>((r) => setTimeout(r, ms));
	};

	const clearLog = (): void => {
		terminal.clearLog();
		metaOffset = capturedMetas.length;
	};

	const getAnalyzed = (): FlickerFrameAnalysis[] => {
		const frameRecords = terminal.getFrames();
		return frameRecords.map((fr, i) => {
			const metaIdx = metaOffset + i;
			return analyzeFlickerFrame(fr, capturedMetas[metaIdx], capturedLogical[metaIdx]);
		});
	};

	const eraseCount = (): number => (terminal.getRawLog().match(RE_ERASE_LINE) ?? []).length;

	// -- Byte-stream assertions --

	const assertEraseLines = (expected: number, label?: string): void => {
		const actual = eraseCount();
		if (actual !== expected) {
			const diag = formatMultiFrameDiag(getAnalyzed(), label ?? "assertEraseLines");
			expect(actual, `expected ${expected} erase-lines, got ${actual}${diag}`).toBe(expected);
		}
	};

	const assertMaxEraseLinesPerFrame = (max: number, label?: string): void => {
		const frames = getAnalyzed();
		for (let i = 0; i < frames.length; i++) {
			const a = frames[i]!;
			if (a.eraseLineCount > max) {
				const diag = formatFrameDiag(a, i);
				expect(
					a.eraseLineCount,
					`frame ${i} erased ${a.eraseLineCount} lines (max ${max})${label ? ` [${label}]` : ""}\n${diag}`,
				).toBeLessThanOrEqual(max);
			}
		}
	};

	const assertNoClearScreen = (label?: string): void => {
		const frames = getAnalyzed();
		for (let i = 0; i < frames.length; i++) {
			const a = frames[i]!;
			if (a.hasClearScreen) {
				const diag = formatFrameDiag(a, i);
				expect(
					a.hasClearScreen,
					`frame ${i} contained \\x1b[2J (clear screen)${label ? ` [${label}]` : ""}\n${diag}`,
				).toBe(false);
			}
		}
	};

	const assertSyncBrackets = (label?: string): void => {
		const frames = getAnalyzed();
		for (let i = 0; i < frames.length; i++) {
			const a = frames[i]!;
			if (!a.hasSyncBrackets) {
				const diag = formatFrameDiag(a, i);
				expect(
					a.hasSyncBrackets,
					`frame ${i} missing DEC 2026 sync brackets${label ? ` [${label}]` : ""}\n${diag}`,
				).toBe(true);
			}
		}
	};

	const assertCursorHidden = (label?: string): void => {
		const frames = getAnalyzed();
		for (let i = 0; i < frames.length; i++) {
			const a = frames[i]!;
			if (a.absolutePositions.length > 0 && !a.cursorHiddenBeforeMove) {
				const diag = formatFrameDiag(a, i);
				expect(
					a.cursorHiddenBeforeMove,
					`frame ${i} moved cursor before hiding it${label ? ` [${label}]` : ""}\n${diag}`,
				).toBe(true);
			}
		}
	};

	const assertBytesBelow = (threshold: number, label?: string): void => {
		const actual = terminal.getRawLog().length;
		if (actual >= threshold) {
			const diag = formatMultiFrameDiag(getAnalyzed(), label ?? "assertBytesBelow");
			expect(actual, `expected < ${threshold} bytes, got ${actual}${diag}`).toBeLessThan(threshold);
		}
	};

	const assertContentNotRewritten = (text: string, label?: string): void => {
		const raw = terminal.getRawLog();
		if (raw.includes(text)) {
			const diag = formatMultiFrameDiag(getAnalyzed(), label ?? "assertContentNotRewritten");
			expect(
				raw.includes(text),
				`frame redraws content "${text}" that should be stable${diag}`,
			).toBe(false);
		}
	};

	const assertRenderPath = (expected: RenderMeta["renderPath"], label?: string): void => {
		const actual = tui.renderMeta.renderPath;
		if (actual !== expected) {
			const frames = getAnalyzed();
			const last = frames.length > 0 ? formatFrameDiag(frames[frames.length - 1]!, frames.length - 1) : "(no frames)";
			expect(
				actual,
				`expected renderPath "${expected}", got "${actual}"${label ? ` [${label}]` : ""}\n${last}`,
			).toBe(expected);
		}
	};

	// -- Grid assertions --

	const doCapture = async (): Promise<GridSnapshot> => {
		await terminal.flush();
		return captureGrid(terminal);
	};

	const doScrollback = async (): Promise<string[]> => {
		await terminal.flush();
		return captureScrollback(terminal);
	};

	const assertViewport = async (expected: string[], label?: string): Promise<void> => {
		const grid = await doCapture();
		const actual = gridToText(grid);
		for (let r = 0; r < expected.length; r++) {
			if (r >= actual.length || actual[r]!.trimEnd() !== expected[r]!.trimEnd()) {
				const fullActual = actual.map((l, i) => `  ${i}: "${l.trimEnd()}"`).join("\n");
				const fullExpected = expected.map((l, i) => `  ${i}: "${l}"`).join("\n");
				expect(
					actual[r]?.trimEnd(),
					`viewport row ${r} mismatch${label ? ` [${label}]` : ""}\nexpected:\n${fullExpected}\nactual:\n${fullActual}`,
				).toBe(expected[r]!.trimEnd());
			}
		}
	};

	const assertChangedRows = (before: GridSnapshot, after: GridSnapshot, expectedRows: number[], label?: string): void => {
		const actual = changedRows(before, after);
		if (JSON.stringify(actual) !== JSON.stringify(expectedRows)) {
			const gridDiag = formatGridContext(before, after);
			const byteDiag = formatMultiFrameDiag(getAnalyzed(), label ?? "assertChangedRows");
			expect(
				actual,
				`expected rows [${expectedRows.join(", ")}] to change, got [${actual.join(", ")}]${gridDiag}${byteDiag}`,
			).toEqual(expectedRows);
		}
	};

	const assertNoBlanking = (before: GridSnapshot, after: GridSnapshot, label?: string): void => {
		const diff = diffGrids(before, after);
		if (diff.blanked.length > 0) {
			const gridDiag = formatGridContext(before, after);
			expect(
				diff.blanked.length,
				`${diff.blanked.length} cells were blanked (content -> empty)${label ? ` [${label}]` : ""}${gridDiag}`,
			).toBe(0);
		}
	};

	const assertGridUnchanged = (before: GridSnapshot, after: GridSnapshot, label?: string): void => {
		const diff = diffGrids(before, after);
		if (diff.changed.length > 0) {
			const gridDiag = formatGridContext(before, after);
			expect(
				diff.changed.length,
				`${diff.changed.length} cells changed when grid should be identical${label ? ` [${label}]` : ""}${gridDiag}`,
			).toBe(0);
		}
	};

	return {
		terminal,
		tui,
		settle,
		clearLog,
		frames: () => terminal.getFrames(),
		analyzed: getAnalyzed,
		eraseLineCount: eraseCount,
		byteCount: () => terminal.getRawLog().length,
		assertEraseLines,
		assertMaxEraseLinesPerFrame,
		assertNoClearScreen,
		assertSyncBrackets,
		assertCursorHidden,
		assertBytesBelow,
		assertContentNotRewritten,
		assertRenderPath,
		captureGrid: doCapture,
		captureScrollback: doScrollback,
		assertViewport,
		assertChangedRows,
		assertNoBlanking,
		assertGridUnchanged,
	};
}
