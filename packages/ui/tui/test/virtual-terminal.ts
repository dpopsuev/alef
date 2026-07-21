import type { Terminal as XtermTerminalType } from "@xterm/headless";
import xterm from "@xterm/headless";
import type { Terminal } from "../src/terminal.js";

const XtermTerminal = xterm.Terminal;

export class VirtualTerminal implements Terminal {
	private xterm: XtermTerminalType;
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private _columns: number;
	private _rows: number;

	constructor(columns = 80, rows = 24) {
		this._columns = columns;
		this._rows = rows;

		this.xterm = new XtermTerminal({
			cols: columns,
			rows: rows,
			disableStdin: true,
			allowProposedApi: true,
		});
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
		this.xterm.write("\x1b[?2004h");
	}

	stop(): void {
		this.xterm.write("\x1b[?2004l");
		this.inputHandler = undefined;
		this.resizeHandler = undefined;
	}

	write(data: string): void {
		this.xterm.write(data);
	}

	get columns(): number {
		return this._columns;
	}

	get rows(): number {
		return this._rows;
	}

	get dec2026Active(): boolean {
		return true;
	}

	hideCursor(): void {
		this.xterm.write("\x1b[?25l");
	}

	showCursor(): void {
		this.xterm.write("\x1b[?25h");
	}

	// -- Test helpers (not on Terminal interface) --

	sendInput(data: string): void {
		this.inputHandler?.(data);
	}

	resize(columns: number, rows: number): void {
		this._columns = columns;
		this._rows = rows;
		this.xterm.resize(columns, rows);
		this.resizeHandler?.();
	}

	async flush(): Promise<void> {
		return new Promise<void>((resolve) => {
			this.xterm.write("", () => resolve());
		});
	}

	async flushAndGetViewport(): Promise<string[]> {
		await this.flush();
		return this.getViewport();
	}

	getViewport(): string[] {
		const lines: string[] = [];
		const buffer = this.xterm.buffer.active;
		for (let i = 0; i < this.xterm.rows; i++) {
			const line = buffer.getLine(buffer.viewportY + i);
			lines.push(line ? line.translateToString(true) : "");
		}
		return lines;
	}

	getScrollBuffer(): string[] {
		const lines: string[] = [];
		const buffer = this.xterm.buffer.active;
		for (let i = 0; i < buffer.length; i++) {
			const line = buffer.getLine(i);
			lines.push(line ? line.translateToString(true) : "");
		}
		return lines;
	}

	getScrollbackAboveViewport(): string[] {
		const lines: string[] = [];
		const buffer = this.xterm.buffer.active;
		for (let i = 0; i < buffer.viewportY; i++) {
			const line = buffer.getLine(i);
			lines.push(line ? line.translateToString(true) : "");
		}
		return lines;
	}

	clear(): void {
		this.xterm.clear();
	}

	reset(): void {
		this.xterm.reset();
	}

	getCursorPosition(): { x: number; y: number } {
		const buffer = this.xterm.buffer.active;
		return { x: buffer.cursorX, y: buffer.cursorY };
	}

	async waitForRender(): Promise<void> {
		await new Promise<void>((resolve) => process.nextTick(resolve));
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		await this.flush();
	}
}
