/**
 * Typewriter — chunk-stream middleware for smooth LLM text animation.
 *
 * Sits between the LLM chunk source and a downstream consumer:
 *
 *   LLM onResponseChunk(chunk)
 *        ↓
 *   typewriter.receive(chunk)   ← raw chunks arrive at LLM rate
 *        ↓  (ticked at ~60fps, adaptive chars-per-frame)
 *   downstream(delta)           ← smoothed delta chunks
 *        ↓
 *   replyBlock.receiveText(delta)
 *
 * The Typewriter is stateless with respect to display: it only manages
 * the reveal schedule. The downstream consumer owns the rendered text.
 *
 * flush() drains all pending chars instantly — call before tool starts
 * or turn ends so the animation completes before structural changes.
 */

export interface TypewriterConfig {
	tickMs?: number;
	maxCharsPerTick?: number;
}

const DEFAULT_TICK_MS = 16;
const DEFAULT_MAX_CHARS = 8;

export class Typewriter {
	private pending = "";
	private revealed = 0;
	private lastEmitted = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;

	private readonly tickMs: number;
	private readonly maxCharsPerTick: number;

	constructor(
		private readonly downstream: (delta: string) => void,
		private readonly requestRender: () => void,
		config: TypewriterConfig = {},
	) {
		this.tickMs = config.tickMs ?? DEFAULT_TICK_MS;
		this.maxCharsPerTick = config.maxCharsPerTick ?? DEFAULT_MAX_CHARS;
	}

	receive(chunk: string): void {
		this.pending += chunk;
		this.scheduleIfIdle();
	}

	/** Instantly emit all remaining buffered chars. */
	flush(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		const remaining = this.pending.length - this.revealed;
		if (remaining > 0) {
			const delta = this.pending.slice(this.revealed);
			this.revealed = this.pending.length;
			this.lastEmitted = this.revealed;
			this.downstream(delta);
			this.requestRender();
		}
	}

	/** Flush and wipe all state — call when the source resets (new turn). */
	reset(): void {
		this.flush();
		this.pending = "";
		this.revealed = 0;
		this.lastEmitted = 0;
	}

	private charsPerTick(): number {
		const pressure = this.pending.length - this.revealed;
		if (pressure <= 20) return 1;
		if (pressure <= 80) return 2;
		if (pressure <= 250) return 4;
		return this.maxCharsPerTick;
	}

	private scheduleIfIdle(): void {
		if (!this.timer && this.pending.length > this.revealed) {
			this.timer = setTimeout(() => this.tick(), this.tickMs);
		}
	}

	private tick(): void {
		this.timer = undefined;
		const step = Math.min(this.charsPerTick(), this.pending.length - this.revealed);
		if (step <= 0) return;

		this.revealed += step;
		const delta = this.pending.slice(this.lastEmitted, this.revealed);
		this.lastEmitted = this.revealed;
		this.downstream(delta);
		this.requestRender();

		if (this.revealed < this.pending.length) {
			this.timer = setTimeout(() => this.tick(), this.tickMs);
		}
	}
}
