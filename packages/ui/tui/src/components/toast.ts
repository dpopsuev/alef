import type { Component } from "../component.js";
import { truncateToWidth } from "../utils.js";

export interface ToastTheme {
	text: (s: string) => string;
	dim: (s: string) => string;
}

export interface ToastOptions {
	message: string;
	durationMs?: number;
	theme: ToastTheme;
	onExpire?: () => void;
}

export class Toast implements Component {
	private message: string;
	private expired = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly theme: ToastTheme;

	constructor(opts: ToastOptions) {
		this.message = opts.message;
		this.theme = opts.theme;
		const duration = opts.durationMs ?? 3000;
		if (duration > 0) {
			this.timer = setTimeout(() => {
				this.expired = true;
				opts.onExpire?.();
			}, duration);
		}
	}

	get isExpired(): boolean {
		return this.expired;
	}

	dismiss(): void {
		if (this.timer) clearTimeout(this.timer);
		this.expired = true;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.expired) return [];
		return [this.theme.text(truncateToWidth(`  ${this.message}`, width, "…"))];
	}
}
