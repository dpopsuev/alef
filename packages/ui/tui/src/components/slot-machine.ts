import type { Component, TuiHandle } from "../component.js";

export interface SlotMachineOptions<T> {
	format: (value: T) => string;
	interpolate: (from: T, to: T, progress: number) => T;
	style: (text: string) => string;
	dimStyle: (text: string) => string;
	prefix?: string;
	durationMs?: number;
	frameIntervalMs?: number;
}

const DEFAULT_DURATION_MS = 400;
const DEFAULT_FRAME_INTERVAL_MS = 50;

export function numericInterpolator(from: number, to: number, progress: number): number {
	const eased = easeOutCubic(progress);
	const jitter = progress < 0.6 ? Math.round((Math.random() - 0.5) * Math.abs(to - from) * 0.3) : 0;
	return Math.round(from + (to - from) * eased + jitter);
}

export function glyphInterpolator(alphabet: readonly string[]): (from: string, to: string, progress: number) => string {
	return (_from, to, progress) => {
		if (progress >= 0.8) return to;
		return alphabet[Math.floor(Math.random() * alphabet.length)] ?? to;
	};
}

export class SlotMachine<T> implements Component {
	private value: T;
	private targetValue: T;
	private animating = false;
	private frameCount = 0;
	private readonly totalFrames: number;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private readonly opts: Required<SlotMachineOptions<T>>;
	private readonly ui: TuiHandle;

	constructor(ui: TuiHandle, initial: T, opts: SlotMachineOptions<T>) {
		this.ui = ui;
		this.value = initial;
		this.targetValue = initial;
		this.opts = {
			format: opts.format,
			interpolate: opts.interpolate,
			style: opts.style,
			dimStyle: opts.dimStyle,
			prefix: opts.prefix ?? "",
			durationMs: opts.durationMs ?? DEFAULT_DURATION_MS,
			frameIntervalMs: opts.frameIntervalMs ?? DEFAULT_FRAME_INTERVAL_MS,
		};
		this.totalFrames = Math.ceil(this.opts.durationMs / this.opts.frameIntervalMs);
	}

	set(target: T): void {
		if (target === this.targetValue && !this.animating) return;
		this.value = this.targetValue;
		this.targetValue = target;
		if (!this.animating) this.startAnimation();
	}

	get(): T {
		return this.targetValue;
	}

	get isAnimating(): boolean {
		return this.animating;
	}

	current(): string {
		const display = this.animating ? this.value : this.targetValue;
		return `${this.opts.prefix}${this.opts.format(display)}`;
	}

	currentStyled(): string {
		const text = this.current();
		if (!this.animating) return this.opts.style(text);
		const progress = this.frameCount / this.totalFrames;
		return progress < 0.7 ? this.opts.dimStyle(text) : this.opts.style(text);
	}

	invalidate(): void {}

	dispose(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.animating = false;
	}

	render(_width: number): string[] {
		const text = this.currentStyled();
		return text ? [text] : [];
	}

	private startAnimation(): void {
		this.animating = true;
		this.frameCount = 0;
		this.tick();
	}

	private tick(): void {
		this.frameCount++;
		const progress = this.frameCount / this.totalFrames;

		if (progress >= 1) {
			this.value = this.targetValue;
			this.animating = false;
			this.timer = null;
			this.ui.requestRender();
			return;
		}

		this.value = this.opts.interpolate(this.value, this.targetValue, progress);
		this.ui.requestRender();
		// lint-ignore: RAWTIMER animation frame tick
		this.timer = setTimeout(() => this.tick(), this.opts.frameIntervalMs);
	}
}

function easeOutCubic(t: number): number {
	return 1 - (1 - t) ** 3;
}
