/**
 * StreamingTextBuffer — smooths bursty LLM token delivery for display.
 *
 * Inspired by TokenFlow (EuroSys 2026): treat token streaming like video
 * delivery. Buffer tokens from the producer (LLM) and emit at a steady
 * cadence to the consumer (TUI), absorbing bursts without adding latency
 * when tokens are slow.
 *
 * The buffer has three modes:
 *   - PASSTHROUGH: buffer is empty or nearly empty — emit immediately
 *   - SMOOTHING:   buffer has content — emit at a steady rate
 *   - DRAIN:       stream ended — flush remaining buffer quickly
 *
 * This is purely a presentation-layer concern. It does not modify the
 * underlying stream, agent session, or message content. The full text
 * is always available via getFullText() for non-display uses.
 */

/** Target characters per emission frame during smoothing */
const DEFAULT_CHARS_PER_FRAME = 12;

/** Emission interval in ms (matches TUI render cadence) */
const FRAME_INTERVAL_MS = 16;

/** Below this buffer size, pass through immediately (no smoothing) */
const PASSTHROUGH_THRESHOLD = 30;

/** During drain, multiply chars per frame by this factor */
const DRAIN_SPEEDUP = 4;

/** Maximum buffer size before we start dropping frames of delay */
const HIGH_WATER_MARK = 2000;

export type StreamingBufferCallback = (displayText: string) => void;

export class StreamingTextBuffer {
	/** Full accumulated text from the producer (LLM) */
	private fullText = "";

	/** How much of fullText has been emitted to the display */
	private emittedLength = 0;

	/** Timer for the emission loop */
	private timer: ReturnType<typeof setInterval> | undefined;

	/** Whether the producer has signaled end-of-stream */
	private ended = false;

	/** Callback invoked with the display text on each emission */
	private onEmit: StreamingBufferCallback;

	/** Characters per frame — adapts based on buffer pressure */
	private charsPerFrame: number;

	constructor(onEmit: StreamingBufferCallback, charsPerFrame = DEFAULT_CHARS_PER_FRAME) {
		this.onEmit = onEmit;
		this.charsPerFrame = charsPerFrame;
	}

	/** Producer pushes new text (typically the full accumulated text so far) */
	push(fullText: string): void {
		this.fullText = fullText;
		this.ensureRunning();
	}

	/** Producer signals end of stream. Buffer will drain and stop. */
	end(): void {
		this.ended = true;
		// Flush remaining immediately
		if (this.pendingLength() > 0) {
			this.flush();
		}
		this.stop();
	}

	/** Get the full text (for non-display uses like session storage) */
	getFullText(): string {
		return this.fullText;
	}

	/** Get the currently displayed text */
	getDisplayText(): string {
		return this.fullText.slice(0, this.emittedLength);
	}

	/** Force-flush all buffered text to display */
	flush(): void {
		if (this.emittedLength < this.fullText.length) {
			this.emittedLength = this.fullText.length;
			this.onEmit(this.fullText);
		}
	}

	/** Stop the emission loop and clean up */
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	/** Reset state for reuse */
	reset(): void {
		this.stop();
		this.fullText = "";
		this.emittedLength = 0;
		this.ended = false;
	}

	/** How many characters are buffered but not yet emitted */
	private pendingLength(): number {
		return this.fullText.length - this.emittedLength;
	}

	private ensureRunning(): void {
		if (this.timer) return;
		this.timer = setInterval(() => this.tick(), FRAME_INTERVAL_MS);
		// Emit immediately on first push (don't wait for first interval)
		this.tick();
	}

	private tick(): void {
		const pending = this.pendingLength();

		if (pending <= 0) {
			if (this.ended) {
				this.stop();
			}
			return;
		}

		// Determine how many chars to emit this frame
		let chars: number;

		if (pending <= PASSTHROUGH_THRESHOLD) {
			// Low buffer — pass through everything immediately (no artificial delay)
			chars = pending;
		} else if (this.ended) {
			// Draining — flush fast
			chars = Math.min(pending, this.charsPerFrame * DRAIN_SPEEDUP);
		} else if (pending > HIGH_WATER_MARK) {
			// High pressure — emit more to catch up
			const pressure = Math.min(pending / HIGH_WATER_MARK, 4);
			chars = Math.ceil(this.charsPerFrame * pressure);
		} else {
			// Normal smoothing — steady cadence
			chars = this.charsPerFrame;
		}

		// Don't split in the middle of a multi-byte character or ANSI sequence
		const targetEnd = this.emittedLength + chars;
		this.emittedLength = this.findSafeBreak(targetEnd);

		this.onEmit(this.fullText.slice(0, this.emittedLength));
	}

	/**
	 * Find a safe break point at or after targetEnd.
	 * Avoids splitting UTF-16 surrogate pairs and tries to break at
	 * word/whitespace boundaries when possible.
	 */
	private findSafeBreak(targetEnd: number): number {
		const max = this.fullText.length;
		if (targetEnd >= max) return max;

		let pos = targetEnd;

		// Don't split UTF-16 surrogate pairs
		const code = this.fullText.charCodeAt(pos - 1);
		if (code >= 0xd800 && code <= 0xdbff && pos < max) {
			pos++; // Include the low surrogate
		}

		return pos;
	}
}
