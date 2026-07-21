import type { Terminal } from "./terminal.js";

/** String-collecting Terminal stub for tests that inspect raw output. */
/** In-memory Terminal for unit tests — collects write() output as string[]. */
export class MockTerminal implements Terminal {
	readonly output: string[] = [];
	private _columns: number;
	private _rows: number;
	private _onInput: ((data: string) => void) | null = null;
	private _onResize: (() => void) | null = null;
	private _started = false;

	constructor(columns = 80, rows = 24) {
		this._columns = columns;
		this._rows = rows;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this._onInput = onInput;
		this._onResize = onResize;
		this._started = true;
	}

	stop(): void {
		this._started = false;
		this._onInput = null;
		this._onResize = null;
	}

	write(data: string): void {
		this.output.push(data);
	}

	get columns(): number {
		return this._columns;
	}
	get rows(): number {
		return this._rows;
	}
	get dec2026Active(): boolean {
		return false;
	}

	hideCursor(): void {}
	showCursor(): void {}

	get started(): boolean {
		return this._started;
	}

	simulateInput(data: string): void {
		this._onInput?.(data);
	}

	simulateResize(columns: number, rows: number): void {
		this._columns = columns;
		this._rows = rows;
		this._onResize?.();
	}

	allOutput(): string {
		return this.output.join("");
	}

	stripAnsi(): string {
		return this.allOutput().replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
	}
}
