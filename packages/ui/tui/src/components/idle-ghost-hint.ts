/**
 * Dim shadow hints inside an empty input: idle detector → typewriter → dismiss.
 */

/**
 *
 */
export interface IdleGhostHintOptions {
	/** Start revealing after the editor has been empty this long. */
	idleMs?: number;
	/** Typewriter tick interval. */
	tickMs?: number;
	/** Hide after the full hint has been visible this long. */
	dismissMs?: number;
	/** Default pool cycled after each idle wait. */
	hints?: string[];
	style?: (text: string) => string;
	requestRender: () => void;
	isEmpty: () => boolean;
}

const DEFAULT_IDLE_MS = 10_000;
const DEFAULT_TICK_MS = 28;
const DEFAULT_DISMISS_MS = 8_000;
const DEFAULT_HINTS = [": for commands"] as const;

/**
 *
 */
export class IdleGhostHint {
	private readonly idleMs: number;
	private readonly tickMs: number;
	private readonly dismissMs: number;
	private readonly hints: string[];
	private readonly style: (text: string) => string;
	private readonly requestRender: () => void;
	private readonly isEmpty: () => boolean;

	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	private tickTimer: ReturnType<typeof setTimeout> | undefined;
	private dismissTimer: ReturnType<typeof setTimeout> | undefined;
	private hintIndex = 0;
	private fullText = "";
	private revealed = 0;
	private armed = false;

	constructor(opts: IdleGhostHintOptions) {
		this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
		this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
		this.dismissMs = opts.dismissMs ?? DEFAULT_DISMISS_MS;
		this.hints = opts.hints?.length ? [...opts.hints] : [...DEFAULT_HINTS];
		this.style = opts.style ?? ((s) => s);
		this.requestRender = opts.requestRender;
		this.isEmpty = opts.isEmpty;
	}

	/** Begin watching for idle-empty; call once after mount/focus. */
	arm(): void {
		this.armed = true;
		this.resetIdleClock();
	}

	dispose(): void {
		this.armed = false;
		this.clearAllTimers();
		this.fullText = "";
		this.revealed = 0;
	}

	/** Any keystroke / content change. Clears visible hint; restarts idle if still empty. */
	onActivity(): void {
		this.clearHint();
		if (this.armed) this.resetIdleClock();
	}

	/** Immediate typewriter hint (mode/whichkey/Tab). Only paints while empty. */
	show(text: string): void {
		const next = text.trim();
		if (!next) {
			this.clearHint();
			if (this.armed) this.resetIdleClock();
			return;
		}
		if (!this.isEmpty()) return;
		this.clearAllTimers();
		this.fullText = next;
		this.revealed = 0;
		this.requestRender();
		this.scheduleTick();
	}

	clearHint(): void {
		const had = this.revealed > 0 || this.fullText.length > 0;
		this.clearAllTimers();
		this.fullText = "";
		this.revealed = 0;
		if (had) this.requestRender();
	}

	/** Dim partial hint for the first content line when the editor is empty. */
	overlay(): string {
		if (!this.isEmpty() || this.revealed <= 0) return "";
		return this.style(this.fullText.slice(0, this.revealed));
	}

	/** Test/inspection. */
	get revealedText(): string {
		return this.fullText.slice(0, this.revealed);
	}

	private resetIdleClock(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
		if (!this.armed || !this.isEmpty()) return;
		// lint-ignore: RAWTIMER idle detector for empty-input ghost hints
		this.idleTimer = setTimeout(() => this.beginIdleHint(), this.idleMs);
	}

	private beginIdleHint(): void {
		this.idleTimer = undefined;
		if (!this.armed || !this.isEmpty()) return;
		const hint = this.hints[this.hintIndex % this.hints.length] ?? "";
		this.hintIndex += 1;
		if (!hint) return;
		this.fullText = hint;
		this.revealed = 0;
		this.requestRender();
		this.scheduleTick();
	}

	private scheduleTick(): void {
		if (this.tickTimer) return;
		// lint-ignore: RAWTIMER typewriter tick for input ghost hints
		this.tickTimer = setTimeout(() => this.tick(), this.tickMs);
	}

	private tick(): void {
		this.tickTimer = undefined;
		if (!this.isEmpty() || this.revealed >= this.fullText.length) {
			if (this.revealed >= this.fullText.length && this.fullText.length > 0) {
				this.scheduleDismiss();
			}
			return;
		}
		this.revealed += 1;
		this.requestRender();
		if (this.revealed < this.fullText.length) this.scheduleTick();
		else this.scheduleDismiss();
	}

	private scheduleDismiss(): void {
		if (this.dismissTimer) clearTimeout(this.dismissTimer);
		// lint-ignore: RAWTIMER auto-dismiss ghost hint after dwell
		this.dismissTimer = setTimeout(() => {
			this.dismissTimer = undefined;
			this.clearHint();
			if (this.armed) this.resetIdleClock();
		}, this.dismissMs);
	}

	private clearAllTimers(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		if (this.tickTimer) clearTimeout(this.tickTimer);
		if (this.dismissTimer) clearTimeout(this.dismissTimer);
		this.idleTimer = undefined;
		this.tickTimer = undefined;
		this.dismissTimer = undefined;
	}
}
