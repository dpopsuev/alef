import type { Component } from "../component.js";
import { truncateToWidth } from "../utils.js";

export interface NotificationEntry {
	message: string;
	level: "info" | "success" | "warning" | "error";
	expiresAt: number;
}

export interface NotificationOptions {
	maxVisible?: number;
	styles?: Record<NotificationEntry["level"], (s: string) => string>;
}

export class NotificationQueue implements Component {
	private queue: NotificationEntry[] = [];
	private maxVisible: number;
	private styles: Record<NotificationEntry["level"], (s: string) => string>;

	constructor(opts: NotificationOptions = {}) {
		this.maxVisible = opts.maxVisible ?? 3;
		this.styles = opts.styles ?? {
			info: (s) => s,
			success: (s) => s,
			warning: (s) => s,
			error: (s) => s,
		};
	}

	push(message: string, level: NotificationEntry["level"] = "info", durationMs = 5000): void {
		this.queue.push({ message, level, expiresAt: Date.now() + durationMs });
	}

	invalidate(): void {}

	render(width: number): string[] {
		const now = Date.now();
		this.queue = this.queue.filter((n) => n.expiresAt > now);
		return this.queue.slice(0, this.maxVisible).map((n) => {
			const text = truncateToWidth(`  ${n.message}`, width, "…");
			return this.styles[n.level](text);
		});
	}
}
