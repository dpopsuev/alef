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
 *   pressure  0–10   →  4 chars   (slow, smooth trickle)
 *   pressure 10–50   → 16 chars   (normal LLM pace at 60fps)
 *   pressure 50–200  → 32 chars   (catching up, still paced)
 *   pressure 200+    → 64 chars   (high catchup, hard cap)
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

const DEFAULT_TICK_MS = 16; // 60fps
const DEFAULT_MAX_CHARS_PER_TICK = 64;

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
	 * Instantly reveal all pending content.
	 * For internal use only (abort, reset, sealStreamingSegment).
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
		if (gap <= 10) return 4;
		if (gap <= 50) return 16;
		if (gap <= 200) return 32;
		return this.maxCharsPerTick; // 64 — hard cap, never a dump
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
