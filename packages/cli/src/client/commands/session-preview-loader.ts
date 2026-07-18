/**
 * Debounced session-preview fetches for the session picker.
 * Rapid j/k must not start a load per step — only after focus settles,
 * then fetch the focused session plus nearby neighbors in parallel.
 */
import type { DisplayBlock } from "@dpopsuev/alef-session/context";
import {
	type PreviewCacheEntry,
	SESSION_PREVIEW_TURNS_INITIAL,
	settlePreviewFailure,
	settlePreviewSuccess,
	shouldLoadPreview,
} from "./session-preview-cache.js";

/** Wait this long without selection change before starting preview I/O. */
export const SESSION_PREVIEW_DEBOUNCE_MS = 120;

/** How many list neighbors on each side to prefetch after settle. */
export const SESSION_PREVIEW_NEIGHBOR_RADIUS = 1;

/** Minimal preview fetch surface used by the debounced loader. */
export interface SessionPreviewFetch {
	getSessionPreview(sessionId: string, maxTurns: number): Promise<DisplayBlock[]>;
}

/** Options for {@link SessionPreviewLoader}. */
export interface SessionPreviewLoaderOptions {
	preview: SessionPreviewFetch;
	/** Ordered session ids currently shown in the picker (excludes none; may include __new__). */
	itemValues: () => readonly string[];
	/** Fired when the focused session's cache entry changes (not neighbor-only fills). */
	onFocusedUpdate: () => void;
	debounceMs?: number;
	neighborRadius?: number;
}

/** Counters for performance tests / diagnostics. */
export interface SessionPreviewLoaderStats {
	/** Times focus() accepted a new session id. */
	focusChanges: number;
	/** getSessionPreview invocations started. */
	loadsStarted: number;
	/** onFocusedUpdate invocations (focused-row paint pressure). */
	focusedUpdates: number;
}

/** Debounce + neighbor prefetch controller over a shared preview cache. */
export class SessionPreviewLoader {
	readonly cache = new Map<string, PreviewCacheEntry>();

	private readonly preview: SessionPreviewFetch;
	private readonly itemValues: () => readonly string[];
	private readonly onFocusedUpdate: () => void;
	private readonly debounceMs: number;
	private readonly neighborRadius: number;

	private focusedId: string | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly tokens = new Map<string, number>();
	private readonly _stats: SessionPreviewLoaderStats = {
		focusChanges: 0,
		loadsStarted: 0,
		focusedUpdates: 0,
	};

	constructor(opts: SessionPreviewLoaderOptions) {
		this.preview = opts.preview;
		this.itemValues = opts.itemValues;
		this.onFocusedUpdate = opts.onFocusedUpdate;
		this.debounceMs = opts.debounceMs ?? SESSION_PREVIEW_DEBOUNCE_MS;
		this.neighborRadius = opts.neighborRadius ?? SESSION_PREVIEW_NEIGHBOR_RADIUS;
	}

	/** Current focused session id (for tests / render). */
	get focused(): string | undefined {
		return this.focusedId;
	}

	/** Snapshot of load/focus counters. */
	get stats(): Readonly<SessionPreviewLoaderStats> {
		return { ...this._stats };
	}

	/** True while waiting for debounce on this id with no cached blocks yet. */
	isPending(sessionId: string): boolean {
		if (this.focusedId !== sessionId || sessionId === "__new__") return false;
		const entry = this.cache.get(sessionId);
		if (entry?.blocks.length || entry?.loading || entry?.error) return false;
		return this.timer !== undefined;
	}

	/**
	 * Selection changed. No-op when focus is unchanged (avoids resetting debounce
	 * on every preview paint). Schedules a settled load after debounceMs.
	 */
	focus(sessionId: string): void {
		if (sessionId === this.focusedId) return;
		this.focusedId = sessionId;
		this._stats.focusChanges++;
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		if (sessionId === "__new__") return;

		const entry = this.cache.get(sessionId);
		if (entry?.blocks.length || entry?.loading) {
			this.timer = setTimeout(() => {
				this.timer = undefined;
				this.prefetchNeighbors(sessionId);
			}, this.debounceMs);
			return;
		}

		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.loadFocusedAndNeighbors(sessionId);
		}, this.debounceMs);
	}

	/** Immediate load (e.g. preview scroll needing more turns) — bypasses debounce. */
	loadNow(sessionId: string, turns: number): void {
		if (sessionId === "__new__") return;
		this.startLoad(sessionId, turns);
	}

	clear(): void {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		this.focusedId = undefined;
		this.cache.clear();
		this.tokens.clear();
		this._stats.focusChanges = 0;
		this._stats.loadsStarted = 0;
		this._stats.focusedUpdates = 0;
	}

	dispose(): void {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		this.tokens.clear();
	}

	/** Session ids to fetch for a settled focus (focused + neighbors). */
	targetsFor(sessionId: string): string[] {
		return neighborSessionIds(this.itemValues(), sessionId, this.neighborRadius);
	}

	private loadFocusedAndNeighbors(sessionId: string): void {
		if (this.focusedId !== sessionId) return;
		for (const id of this.targetsFor(sessionId)) {
			this.startLoad(id, SESSION_PREVIEW_TURNS_INITIAL);
		}
	}

	private prefetchNeighbors(sessionId: string): void {
		if (this.focusedId !== sessionId) return;
		for (const id of this.targetsFor(sessionId)) {
			if (id === sessionId) continue;
			this.startLoad(id, SESSION_PREVIEW_TURNS_INITIAL);
		}
	}

	private startLoad(sessionId: string, turns: number): void {
		const existing = this.cache.get(sessionId);
		if (!shouldLoadPreview(existing, turns)) return;

		const token = (this.tokens.get(sessionId) ?? 0) + 1;
		this.tokens.set(sessionId, token);
		this._stats.loadsStarted++;

		this.cache.set(sessionId, {
			turns,
			blocks: existing?.blocks ?? [],
			exhausted: existing?.exhausted ?? false,
			loading: true,
		});
		if (sessionId === this.focusedId) this.emitFocusedUpdate();

		void this.preview.getSessionPreview(sessionId, turns).then(
			(blocks) => {
				if (this.tokens.get(sessionId) !== token) return;
				this.cache.set(sessionId, settlePreviewSuccess(this.cache.get(sessionId), turns, blocks));
				if (sessionId === this.focusedId) this.emitFocusedUpdate();
			},
			(error: unknown) => {
				if (this.tokens.get(sessionId) !== token) return;
				this.cache.set(sessionId, settlePreviewFailure(this.cache.get(sessionId), turns, error));
				if (sessionId === this.focusedId) this.emitFocusedUpdate();
			},
		);
	}

	private emitFocusedUpdate(): void {
		this._stats.focusedUpdates++;
		this.onFocusedUpdate();
	}
}

/** Collect focused id plus ±radius neighbors, skipping `__new__`. */
export function neighborSessionIds(itemValues: readonly string[], focusedId: string, radius: number): string[] {
	if (focusedId === "__new__") return [];
	const index = itemValues.indexOf(focusedId);
	if (index < 0) return [focusedId];
	const ids: string[] = [];
	for (let offset = -radius; offset <= radius; offset++) {
		const id = itemValues[index + offset];
		if (!id || id === "__new__") continue;
		if (!ids.includes(id)) ids.push(id);
	}
	return ids;
}
