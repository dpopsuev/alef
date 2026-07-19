import type { Component } from "../component.js";
import { truncateToWidth } from "../utils.js";

/** One row in a pending queue panel. */
export interface PendingQueueEntry {
	id: string;
	text: string;
	/** Optional label prepended before the text (e.g. "Follow-up"). */
	prefix?: string;
}

/** Theme hooks for pending queue lines. */
export interface PendingQueueTheme {
	item: (s: string) => string;
	hint?: (s: string) => string;
}

/** Options for PendingQueuePanel. */
export interface PendingQueueOptions {
	theme: PendingQueueTheme;
	/** Footer hint shown under the list when non-empty. */
	hint?: string;
	/** Max item rows to render; excess are summarized. Default: unlimited. */
	maxVisible?: number;
}

/**
 * Generic sticky panel for pending/queued items (messages, tasks, etc.).
 * Composes truncated one-line rows — same shape as a pending-messages strip.
 */
export class PendingQueuePanel implements Component {
	private entries: PendingQueueEntry[] = [];
	private hint: string | undefined;
	private readonly theme: PendingQueueTheme;
	private readonly maxVisible: number | undefined;
	private seq = 0;

	constructor(opts: PendingQueueOptions) {
		this.theme = opts.theme;
		this.hint = opts.hint;
		this.maxVisible = opts.maxVisible;
	}

	get size(): number {
		return this.entries.length;
	}

	getItems(): readonly PendingQueueEntry[] {
		return this.entries;
	}

	/** Replace the full list. */
	setEntries(entries: readonly PendingQueueEntry[]): void {
		this.entries = [...entries];
	}

	/** Append one entry; generates an id when omitted. */
	push(entry: Omit<PendingQueueEntry, "id"> & { id?: string }): void {
		this.seq++;
		this.entries.push({
			id: entry.id ?? `pq-${this.seq}`,
			text: entry.text,
			prefix: entry.prefix,
		});
	}

	/**
	 * Keep the oldest `count` entries (FIFO head).
	 * Used when the backend reports a shorter queue after a drain.
	 */
	setLength(count: number): void {
		const next = Math.max(0, count);
		while (this.entries.length > next) {
			this.entries.shift();
		}
	}

	clear(): void {
		this.entries = [];
	}

	setHint(hint: string | undefined): void {
		this.hint = hint;
	}

	invalidate(): void {
		// No cached layout state.
	}

	render(width: number): string[] {
		if (this.entries.length === 0) return [];

		const lines: string[] = [""];
		const visible =
			this.maxVisible !== undefined && this.entries.length > this.maxVisible
				? this.entries.slice(0, this.maxVisible)
				: this.entries;

		for (const entry of visible) {
			const label = entry.prefix ? `${entry.prefix}: ${entry.text}` : entry.text;
			lines.push(this.theme.item(truncateToWidth(label, width, "…")));
		}

		const hidden = this.entries.length - visible.length;
		if (hidden > 0) {
			const more = `… +${hidden} more`;
			lines.push(this.theme.item(truncateToWidth(more, width, "…")));
		}

		if (this.hint) {
			const style = this.theme.hint ?? this.theme.item;
			lines.push(style(truncateToWidth(this.hint, width, "…")));
		}

		return lines;
	}
}
