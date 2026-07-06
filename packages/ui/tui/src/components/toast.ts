import type { Component } from "../component.js";
import { truncateToWidth } from "../utils.js";

/**
 *
 */
export interface ToastTheme {
	text: (s: string) => string;
	dim: (s: string) => string;
}

/**
 *
 */
export interface ToastOptions {
	message?: string;
	content?: Component;
	durationMs?: number;
	theme: ToastTheme;
	onExpire?: () => void;
}

/**
 *
 */
export class Toast implements Component {
	private message: string | undefined;
	private content: Component | undefined;
	private expired = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly theme: ToastTheme;

	constructor(opts: ToastOptions) {
		this.message = opts.message;
		this.content = opts.content;
		this.theme = opts.theme;
		const duration = opts.durationMs ?? 3000;
		if (duration > 0) {
			// lint-ignore: RAWTIMER toast auto-dismiss lifecycle
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

	invalidate(): void {
		this.content?.invalidate();
	}

	render(width: number): string[] {
		if (this.expired) return [];
		if (this.content) return this.content.render(width);
		return [this.theme.text(truncateToWidth(`  ${this.message ?? ""}`, width, "…"))];
	}
}
