/**
 * Pressure-based JIT typewriter.
 *
 * Received content accumulates in a pending buffer. A self-scheduling tick
 * reveals characters toward a sink at a rate determined by two axes:
 *
 *   pressure  = pending.length - displayed.length  (chars not yet shown)
 *   streaming = whether the source is still sending chunks
 *
 * When pressure is low and streaming is active, the tick runs slowly and
 * reveals few chars — smooth typewriter. When pressure is high or streaming
 * has stopped, the tick runs fast and reveals more — catch-up drain.
 */

export interface TypewriterSink {
	setText(text: string): void;
}

export interface TypewriterTickIntervals {
	slowMs: number; // low pressure, streaming active  — default 32ms (~30fps)
	normalMs: number; // medium pressure                 — default 16ms (~60fps)
	fastMs: number; // high pressure or stream stopped — default  8ms (~120fps)
}

export interface TypewriterConfig {
	intervals?: Partial<TypewriterTickIntervals>;
	streamingPauseMs?: number; // treat stream as done after N ms silence (default 150)
}

const DEFAULT_INTERVALS: TypewriterTickIntervals = { slowMs: 32, normalMs: 16, fastMs: 8 };
const DEFAULT_STREAMING_PAUSE_MS = 150;

export class Typewriter {
	private pending = "";
	private displayed = "";
	private streamingActive = false;
	private lastChunkAt = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;

	private readonly sink: TypewriterSink;
	private readonly onRender: () => void;
	private readonly intervals: TypewriterTickIntervals;
	private readonly streamingPauseMs: number;

	constructor(sink: TypewriterSink, onRender: () => void, config: TypewriterConfig = {}) {
		this.sink = sink;
		this.onRender = onRender;
		this.intervals = { ...DEFAULT_INTERVALS, ...config.intervals };
		this.streamingPauseMs = config.streamingPauseMs ?? DEFAULT_STREAMING_PAUSE_MS;
	}

	get pressure(): number {
		return this.pending.length - this.displayed.length;
	}

	get effectivelyDone(): boolean {
		return !this.streamingActive || Date.now() - this.lastChunkAt > this.streamingPauseMs;
	}

	/** Append a received chunk from the source. */
	receive(chunk: string): void {
		this.pending += chunk;
		this.streamingActive = true;
		this.lastChunkAt = Date.now();
		this.scheduleIfIdle();
	}

	/** Signal that the source will send no more chunks for this segment. */
	markStreamDone(): void {
		this.streamingActive = false;
		this.scheduleIfIdle();
	}

	/** Instantly reveal all pending content — used when a segment is sealed. */
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

	/** Flush and wipe all state — used between turns. */
	reset(): void {
		this.flush();
		this.pending = "";
		this.displayed = "";
		this.streamingActive = false;
		this.lastChunkAt = 0;
	}

	/**
	 * Characters to reveal per tick.
	 *
	 * When the stream has stopped (or paused), drain half the remaining gap
	 * per tick so the buffer empties in O(log n) ticks.
	 * While streaming, the curve is gentle at low pressure and escalates
	 * as the gap grows, preventing the display from falling far behind.
	 */
	pressureStep(gap: number): number {
		if (this.effectivelyDone) return Math.ceil(Math.max(gap, 1) / 2);
		if (gap <= 2) return 1;
		if (gap <= 8) return 2;
		if (gap <= 25) return 4;
		if (gap <= 70) return 8;
		if (gap <= 180) return 15;
		return Math.ceil(gap / 4);
	}

	/** Tick interval based on current pressure and streaming state. */
	nextTickMs(): number {
		const p = this.pressure;
		if (this.effectivelyDone || p > 60) return this.intervals.fastMs;
		if (p <= 3) return this.intervals.slowMs;
		return this.intervals.normalMs;
	}

	private scheduleIfIdle(): void {
		if (!this.timer && this.pressure > 0) {
			this.timer = setTimeout(() => this.tick(), this.nextTickMs());
		}
	}

	private tick(): void {
		this.timer = undefined;
		const gap = this.pressure;
		if (gap <= 0) return;

		const step = this.pressureStep(gap);
		this.displayed = this.pending.slice(0, this.displayed.length + step);
		this.sink.setText(this.displayed);
		this.onRender();

		if (this.pressure > 0) {
			this.timer = setTimeout(() => this.tick(), this.nextTickMs());
		}
	}
}
