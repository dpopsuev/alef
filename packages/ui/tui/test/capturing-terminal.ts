/**
 * CapturingTerminal — records raw ANSI bytes per render frame.
 *
 * Extends VirtualTerminal so tests get both:
 *   - raw byte assertions (cursor hide/show, clear screen, sync brackets)
 *   - rendered content assertions (getScrollBuffer())
 *
 * Frame boundary: \x1b[?2026l (end-synchronized-output). Every doRender()
 * call ends with this sequence, so each FrameRecord maps to one doRender().
 */

import { VirtualTerminal } from "./virtual-terminal.js";

export interface FrameRecord {
	/** Full raw bytes emitted in this frame. */
	raw: string;
	/** Frame contained \x1b[2J (clear screen — blank frame risk, RC-2). */
	hasClearScreen: boolean;
	/** Frame contained \x1b[?25l (cursor hide). */
	hasCursorHide: boolean;
	/** Frame contained \x1b[?25h (cursor show). */
	hasCursorShow: boolean;
	/** Frame contained at least one \x1b[nA (cursor-up movement). */
	hasCursorUp: boolean;
	/** \x1b[?25l appeared before the first \x1b[nA in this frame (RC-1 invariant). */
	cursorHideBeforeFirstMove: boolean;
	/** Frame opened with \x1b[?2026h (begin synchronized output). */
	syncBegin: boolean;
	/** Frame closed with \x1b[?2026l (end synchronized output). */
	syncEnd: boolean;
}

const RE_CLEAR_SCREEN = /\x1b\[2J/;
const RE_CURSOR_HIDE = /\x1b\[\?25l/;
const RE_CURSOR_SHOW = /\x1b\[\?25h/;
const RE_CURSOR_UP = /\x1b\[\d*A/;
const RE_SYNC_BEGIN = /\x1b\[\?2026h/;
const RE_SYNC_END = /\x1b\[\?2026l/;

function analyzeFrame(raw: string): FrameRecord {
	const hideIdx = raw.search(RE_CURSOR_HIDE);
	const upIdx = raw.search(RE_CURSOR_UP);
	return {
		raw,
		hasClearScreen: RE_CLEAR_SCREEN.test(raw),
		hasCursorHide: hideIdx !== -1,
		hasCursorShow: RE_CURSOR_SHOW.test(raw),
		hasCursorUp: upIdx !== -1,
		cursorHideBeforeFirstMove: hideIdx !== -1 && upIdx !== -1 && hideIdx < upIdx,
		syncBegin: RE_SYNC_BEGIN.test(raw),
		syncEnd: RE_SYNC_END.test(raw),
	};
}

export class CapturingTerminal extends VirtualTerminal {
	private readonly writeLog: string[] = [];

	override write(data: string): void {
		this.writeLog.push(data);
		super.write(data);
	}

	/** All raw bytes emitted since construction (or last clearLog()). */
	getRawLog(): string {
		return this.writeLog.join("");
	}

	/** Reset the write log. */
	clearLog(): void {
		this.writeLog.length = 0;
	}

	/**
	 * Split the write log into per-frame records.
	 * Frames are delimited by \x1b[?2026l (end-synchronized-output).
	 * The delimiter is included in the frame it closes.
	 */
	getFrames(): FrameRecord[] {
		const raw = this.getRawLog();
		const parts = raw.split(/(?<=\x1b\[\?2026l)/);
		return parts.filter((p) => p.trim().length > 0).map((p) => analyzeFrame(p));
	}

	/** RC-8: number of write() calls since last clearLog(). Each frame must be exactly 1. */
	getWriteCount(): number {
		return this.writeLog.length;
	}
}
