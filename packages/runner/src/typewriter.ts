/**
 * Frame-budget typewriter — controlled reveal at a fixed frame rate.
 *
 * One tick = one render frame (default 16ms, ~60fps).
 * Each tick reveals a bounded number of characters — never more than
 * the hard cap regardless of how much is buffered or whether the stream
 * has ended. This prevents the "blob" dump when markStreamDone() fires.
 *
 * Rate science (MDN, display refresh rates):
 *   60fps  →  16ms/frame  — smooth motion threshold for humans
 *   30fps  →  33ms/frame  — minimum "smooth" perception
 *   120fps →   8ms/frame  — high-refresh displays
 *
 * LLM output rate: ~500–2000 chars/sec typical.
 *   At 60fps: 500/60 ≈ 8 chars/frame min, 2000/60 ≈ 33 chars/frame max
 *
 * charsPerFrame schedule (adaptive, but hard-capped):
 *   pressure  0–20   →  1 char    (letter-by-letter trickle, most LLMs)
 *   pressure 20–80   →  2 chars   (moderate pace, still looks like typing)
 *   pressure 80–250  →  4 chars   (catchup, remains readable at 60fps)
 *   pressure 250+    →  8 chars   (drain mode — hard cap, never a dump)
 *
 * At 60fps these rates map to: 60 / 120 / 240 / 480 chars/sec.
 * Typical LLM output is 50–200 chars/sec — the 1–2 char range covers it.
 * The TUI enforces MIN_RENDER_INTERVAL_MS=16 so ticking faster is wasteful.
 *
 * markStreamDone() is a metadata flag only — it does NOT change drain speed.
 * flush() is kept for internal resets (abort, clear) but must NOT be called
 * for user-visible content.
 */

export interface TypewriterSink {
	setText(text: string): void;
}

export interface TypewriterConfig {
	/** Tick interval in ms. Default: 16 (~60fps). */
	tickMs?: number;
	/** Hard cap on chars revealed per tick. Default: 64. */
	maxCharsPerTick?: number;
}

const DEFAULT_TICK_MS = 16; // 60fps — aligned with TUI.MIN_RENDER_INTERVAL_MS
const DEFAULT_MAX_CHARS_PER_TICK = 8;

export class Typewriter {
	private pending = "";
	private displayed = "";
	private timer: ReturnType<typeof setTimeout> | undefined;
	private drainedCallbacks: Array<() => void> = [];

	private readonly sink: TypewriterSink;
	private readonly onRender: () => void;
	private readonly tickMs: number;
	private readonly maxCharsPerTick: number;

	constructor(sink: TypewriterSink, onRender: () => void, config: TypewriterConfig = {}) {
		this.sink = sink;
		this.onRender = onRender;
		this.tickMs = config.tickMs ?? DEFAULT_TICK_MS;
		this.maxCharsPerTick = config.maxCharsPerTick ?? DEFAULT_MAX_CHARS_PER_TICK;
	}

	get pressure(): number {
		return this.pending.length - this.displayed.length;
	}

	/** Full accumulated text (pending + already displayed). Used by flush-fade transitions. */
	get pendingText(): string {
		return this.pending;
	}

	/** Append a received chunk from the source. */
	receive(chunk: string): void {
		this.pending += chunk;
		this.scheduleIfIdle();
	}

	/**
	 * Signal that no more chunks are coming for this segment.
	 * Does NOT change drain speed — drain continues at the same frame rate.
	 */
	markStreamDone(): void {
		// No flush, no rate change. Drain continues at tickMs.
		this.scheduleIfIdle();
	}

	/** Resolve when the display buffer is fully caught up. */
	whenDrained(): Promise<void> {
		if (this.pressure === 0) return Promise.resolve();
		return new Promise((resolve) => {
			this.drainedCallbacks.push(resolve);
		});
	}

	/**
	 * Drain remaining content rapidly into a ghost sink (15 chars / 4ms ticks)
	 * then call onComplete. The caller starts the color animation in onComplete.
	 * ghostSink should render text in a dim/ghost color for the scan effect.
	 * The normal sink is NOT called during rapid flush — ghost appearance only.
	 */
	rapidFlush(ghostSink: TypewriterSink, onComplete: () => void): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		const RAPID_CHARS = 15;
		const RAPID_MS = 4;
		const drain = (): void => {
			const gap = this.pending.length - this.displayed.length;
			if (gap <= 0) {
				onComplete();
				return;
			}
			this.displayed = this.pending.slice(0, this.displayed.length + Math.min(RAPID_CHARS, gap));
			ghostSink.setText(this.displayed);
			this.onRender();
			this.timer = setTimeout(drain, RAPID_MS);
		};
		drain();
	}

	/**
	 * Instantly reveal all pending content.
	 * For internal use only (abort, reset, clearStreamingSegments).
	 * Never call this to "show" user-visible text — it bypasses frame pacing.
	 */
	flush(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		if (this.displayed !== this.pending) {
			this.displayed = this.pending;
			this.sink.setText(this.displayed);
			// Always request a render after a forced flush so the text is
			// visible immediately — the regular tick path calls onRender() but
			// flush() bypasses it.
			this.onRender();
		}
	}

	/** Flush and wipe all state — used on abort / turn reset. */
	reset(): void {
		this.flush();
		this.pending = "";
		this.displayed = "";
		this.drainedCallbacks = [];
	}

	/**
	 * Characters to reveal per tick — bounded by the frame budget.
	 *
	 * Adapts to pressure so the display catches up when the LLM is ahead,
	 * but never dumps more than maxCharsPerTick regardless of stream state.
	 * markStreamDone() does NOT affect this — same cap applies always.
	 */
	charsPerTick(gap: number): number {
		if (gap <= 0) return 0;
		if (gap <= 20) return 1; // letter-by-letter: ~60 chars/sec at 60fps
		if (gap <= 80) return 2; // gentle catchup: ~120 chars/sec
		if (gap <= 250) return 4; // moderate catchup: ~240 chars/sec
		return this.maxCharsPerTick; // drain mode: ~480 chars/sec, hard cap
	}

	private scheduleIfIdle(): void {
		if (!this.timer && this.pressure > 0) {
			this.timer = setTimeout(() => this.tick(), this.tickMs);
		}
	}

	private tick(): void {
		this.timer = undefined;
		const gap = this.pressure;
		if (gap <= 0) {
			const cbs = this.drainedCallbacks.splice(0);
			for (const cb of cbs) cb();
			return;
		}

		const step = this.charsPerTick(gap);
		this.displayed = this.pending.slice(0, this.displayed.length + step);
		this.sink.setText(this.displayed);
		this.onRender();

		if (this.pressure > 0) {
			this.timer = setTimeout(() => this.tick(), this.tickMs);
		} else {
			const cbs = this.drainedCallbacks.splice(0);
			for (const cb of cbs) cb();
		}
	}
}
