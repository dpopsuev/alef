/**
 * RenderRecorder -- test instrumentation for TUI render pipeline.
 *
 * Hooks into TUI.onRender to capture every frame with metadata.
 * Provides assertion helpers that let tests verify:
 * - which render path was taken (diff, dock-reflow, first, etc.)
 * - what lines changed between frames
 * - dock boundary stability
 * - no ghost lines after component add/remove
 */

import type { RenderMeta } from "../src/component.js";
import type { TUI } from "../src/tui.js";

/** Strip ANSI escape sequences for content comparison. */
function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

/** A single captured render frame with metadata. */
export interface CapturedFrame {
	/** Frame index (0-based, monotonically increasing). */
	seq: number;
	/** Raw lines with ANSI intact. */
	lines: string[];
	/** Lines with ANSI stripped. */
	stripped: string[];
	/** Width used for this render. */
	width: number;
	/** Height (terminal rows). */
	height: number;
	/** Render path and change metadata. */
	meta: RenderMeta;
	/** Full redraws counter at time of capture. */
	fullRedraws: number;
	/** Timestamp from performance.now(). */
	capturedAt: number;
}

/** Diff between two consecutive frames. */
export interface FrameDiff {
	/** Lines that changed (index + old/new content, ANSI-stripped). */
	changed: { line: number; old: string; new: string }[];
	/** Lines added (index + content). */
	added: { line: number; content: string }[];
	/** Lines removed (index + content). */
	removed: { line: number; content: string }[];
	/** Whether dock height changed. */
	dockHeightChanged: boolean;
}

export class RenderRecorder {
	private readonly tui: TUI;
	private readonly _frames: CapturedFrame[] = [];
	private seq = 0;

	constructor(tui: TUI) {
		this.tui = tui;
		tui.onRender = (frame, width, height) => {
			const lines = frame.split("\n");
			this._frames.push({
				seq: this.seq++,
				lines,
				stripped: lines.map(stripAnsi),
				width,
				height,
				meta: { ...tui.renderMeta },
				fullRedraws: tui.fullRedraws,
				capturedAt: performance.now(),
			});
		};
	}

	/** All captured frames. */
	get frames(): readonly CapturedFrame[] {
		return this._frames;
	}

	/** The most recent frame. */
	get last(): CapturedFrame | undefined {
		return this._frames[this._frames.length - 1];
	}

	/** Number of frames captured. */
	get count(): number {
		return this._frames.length;
	}

	/** Clear all captured frames. */
	clear(): void {
		this._frames.length = 0;
	}

	/** Compute diff between two frames. */
	diff(a: CapturedFrame, b: CapturedFrame): FrameDiff {
		const changed: FrameDiff["changed"] = [];
		const added: FrameDiff["added"] = [];
		const removed: FrameDiff["removed"] = [];

		const maxLen = Math.max(a.stripped.length, b.stripped.length);
		for (let i = 0; i < maxLen; i++) {
			const oldLine = a.stripped[i];
			const newLine = b.stripped[i];
			if (oldLine === undefined && newLine !== undefined) {
				added.push({ line: i, content: newLine });
			} else if (oldLine !== undefined && newLine === undefined) {
				removed.push({ line: i, content: oldLine });
			} else if (oldLine !== newLine) {
				changed.push({ line: i, old: oldLine!, new: newLine! });
			}
		}

		const dockHeightChanged = a.stripped.length !== b.stripped.length;
		return { changed, added, removed, dockHeightChanged };
	}

	/** Diff between the last two frames. */
	lastDiff(): FrameDiff | null {
		if (this._frames.length < 2) return null;
		return this.diff(this._frames[this._frames.length - 2]!, this._frames[this._frames.length - 1]!);
	}

	/** Frames that used a specific render path. */
	byPath(path: RenderMeta["renderPath"]): CapturedFrame[] {
		return this._frames.filter((f) => f.meta.renderPath === path);
	}

	/** Count of frames by render path. */
	pathCounts(): Record<string, number> {
		const counts: Record<string, number> = {};
		for (const f of this._frames) {
			counts[f.meta.renderPath] = (counts[f.meta.renderPath] ?? 0) + 1;
		}
		return counts;
	}

	// -- Assertion helpers --

	/**
	 * Find frames where a pattern appears on a line that also contains separator chars.
	 * This catches the "shell.exec output bleeding into separator" bug.
	 */
	framesWithContentOnSeparator(contentPattern: RegExp): { frame: CapturedFrame; line: number; text: string }[] {
		const sepRe = /[─\u2500]{3,}/;
		const hits: { frame: CapturedFrame; line: number; text: string }[] = [];
		for (const frame of this._frames) {
			for (let i = 0; i < frame.stripped.length; i++) {
				const line = frame.stripped[i]!;
				if (sepRe.test(line) && contentPattern.test(line)) {
					hits.push({ frame, line: i, text: line });
				}
			}
		}
		return hits;
	}

	/**
	 * Find frames where a specific text appears after it should have been removed.
	 * Detects ghost lines -- stale content from a previous render path.
	 */
	ghostLines(text: string, afterSeq: number): { frame: CapturedFrame; line: number; content: string }[] {
		const hits: { frame: CapturedFrame; line: number; content: string }[] = [];
		for (const frame of this._frames) {
			if (frame.seq <= afterSeq) continue;
			for (let i = 0; i < frame.stripped.length; i++) {
				if (frame.stripped[i]!.includes(text)) {
					hits.push({ frame, line: i, content: frame.stripped[i]! });
				}
			}
		}
		return hits;
	}

	/**
	 * Check that a pattern appears on exactly one line across all frames
	 * (no duplication). Returns frames where it appears more than once.
	 */
	duplicateLines(pattern: RegExp): { frame: CapturedFrame; lines: number[] }[] {
		const hits: { frame: CapturedFrame; lines: number[] }[] = [];
		for (const frame of this._frames) {
			const matching = frame.stripped
				.map((l, i) => (pattern.test(l) ? i : -1))
				.filter((i) => i >= 0);
			if (matching.length > 1) {
				hits.push({ frame, lines: matching });
			}
		}
		return hits;
	}

	/**
	 * For every frame, check that dock elements (separator, INSERT, footer)
	 * stay at consistent viewport rows. Returns frames where they shifted.
	 */
	dockDrift(opts: {
		separatorPattern?: RegExp;
		modePattern?: RegExp;
		footerPattern?: RegExp;
	}): { frame: CapturedFrame; element: string; fromRow: number; toRow: number }[] {
		const sepRe = opts.separatorPattern ?? /[─\u2500]{3,}/;
		const modeRe = opts.modePattern ?? /INSERT|NORMAL/;
		const footerRe = opts.footerPattern ?? /~/;

		const hits: { frame: CapturedFrame; element: string; fromRow: number; toRow: number }[] = [];
		let prevSep = -1;
		let prevMode = -1;
		let prevFooter = -1;

		for (const frame of this._frames) {
			if (frame.meta.renderPath === "first" || frame.meta.renderPath === "dock-reflow") {
				// Reset baseline on full repaints and reflows
				prevSep = -1;
				prevMode = -1;
				prevFooter = -1;
			}

			const s = frame.stripped;
			const sepIdx = s.findIndex((l) => sepRe.test(l) && !modeRe.test(l));
			const modeIdx = s.findIndex((l) => sepRe.test(l) && modeRe.test(l));
			const footerIdx = s.length - 1;

			if (prevSep >= 0 && sepIdx >= 0 && sepIdx !== prevSep) {
				hits.push({ frame, element: "separator", fromRow: prevSep, toRow: sepIdx });
			}
			if (prevMode >= 0 && modeIdx >= 0 && modeIdx !== prevMode) {
				hits.push({ frame, element: "mode-line", fromRow: prevMode, toRow: modeIdx });
			}
			if (prevFooter >= 0 && footerRe.test(s[footerIdx]!) && footerIdx !== prevFooter) {
				hits.push({ frame, element: "footer", fromRow: prevFooter, toRow: footerIdx });
			}

			if (sepIdx >= 0) prevSep = sepIdx;
			if (modeIdx >= 0) prevMode = modeIdx;
			prevFooter = footerIdx;
		}

		return hits;
	}

	/** Destroy the recorder and unhook from TUI. */
	dispose(): void {
		this.tui.onRender = undefined;
		this._frames.length = 0;
	}
}
