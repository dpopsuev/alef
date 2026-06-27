import type { Terminal } from "./terminal.js";

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

	drainInput(): Promise<void> {
		return Promise.resolve();
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
	get kittyProtocolActive(): boolean {
		return false;
	}
	get dec2026Active(): boolean {
		return false;
	}

	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}

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
