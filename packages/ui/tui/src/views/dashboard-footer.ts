import { execSync } from "node:child_process";
import type { Component } from "../component.js";
import { ProgressBar } from "../components/progress-bar.js";
import { truncateToWidth, visibleWidth } from "../utils.js";
import type { TuiStateStore } from "./state.js";

/**
 *
 */
export interface DashboardFooterOptions {
	sessionId: string;
	cwd: string;
	store: TuiStateStore;
	blueprintName?: string;
	requestRender: () => void;
	style: (text: string) => string;
	dimStyle: (text: string) => string;
	warnStyle: (text: string) => string;
	errorStyle: (text: string) => string;
	buildInfo?: { version: string; gitHash: string; gitCommitTimestamp?: string };
	updateAvailable?: { version: string };
}

/**
 *
 */
function fmtTokens(n: number): string {
	if (n <= 0) return "0";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(Math.round(n));
}

/**
 *
 */
function shortPath(cwd: string): string {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	if (home && cwd.startsWith(home)) return `~${cwd.slice(home.length)}`;
	return cwd;
}

/**
 *
 */
function getGitBranch(cwd: string): string | undefined {
	try {
		return execSync("git rev-parse --abbrev-ref HEAD 2>/dev/null", { cwd, encoding: "utf-8" }).trim() || undefined;
	} catch {
		return undefined;
	}
}

const CONTEXT_FILL_ERROR = 0.9;
const CONTEXT_FILL_WARN = 0.7;
const CONTEXT_FILL_ACCENT = 0.5;

const DRAIN_STEPS = 12;
const DRAIN_STEP_MS = 60;
const BLINK_MS = 280;
const CELEBRATE_BLINKS = 4;

type CompactPhase = "idle" | "compacting" | "draining" | "celebrate";

/**
 *
 */
export type FooterPanel = DashboardFooter;

/**
 * Footer chrome: path · compact context spark · model · blueprint.
 * Compaction: blink (attention) then drain (peak-end relief). Respects ALEF_REDUCED_MOTION.
 * Coaching hints (: for commands) live in the empty input, not here.
 */
export class DashboardFooter implements Component {
	private readonly opts: DashboardFooterOptions;
	private readonly branch: string | undefined;
	private unsub: (() => void) | undefined;
	private readonly statuses = new Map<string, string>();
	private hint = "";
	private readonly reducedMotion =
		process.env.ALEF_REDUCED_MOTION === "1" || process.env.NO_MOTION === "1";

	private phase: CompactPhase = "idle";
	private displayUsed = 0;
	private blinkOn = true;
	private timers: ReturnType<typeof setTimeout>[] = [];

	constructor(opts: DashboardFooterOptions) {
		this.opts = opts;
		this.branch = getGitBranch(opts.cwd);
		this.displayUsed = opts.store.get().contextUsed;
		this.unsub = opts.store.subscribe(() => {
			if (this.phase === "idle") {
				this.displayUsed = opts.store.get().contextUsed;
			}
			opts.requestRender();
		});
	}

	invalidate(): void {}

	dispose(): void {
		this.clearTimers();
		this.unsub?.();
	}

	setHint(text: string): void {
		this.hint = text;
		this.opts.requestRender();
	}

	setStatus(key: string, text: string | undefined): void {
		if (text === undefined || text === "") this.statuses.delete(key);
		else this.statuses.set(key, text);
		this.opts.requestRender();
	}

	/** Compaction in progress — blink the context bar to draw selective attention. */
	setCompacting(active: boolean): void {
		this.clearTimers();
		if (active) {
			this.phase = "compacting";
			this.blinkOn = true;
			if (!this.reducedMotion) this.scheduleBlinkLoop();
		} else if (this.phase === "compacting") {
			this.phase = "idle";
			this.blinkOn = true;
		}
		this.opts.requestRender();
	}

	/** Animate context fill from → to after compaction (drain + short celebrate blink). */
	playDrain(from: number, to: number): void {
		this.clearTimers();
		const start = Math.max(0, from);
		const end = Math.max(0, to);
		if (this.reducedMotion || start <= end) {
			this.displayUsed = end;
			this.phase = "idle";
			this.blinkOn = true;
			this.opts.requestRender();
			return;
		}

		this.phase = "draining";
		this.displayUsed = start;
		this.blinkOn = true;
		this.opts.requestRender();

		let step = 0;
		const tick = (): void => {
			step++;
			const t = Math.min(1, step / DRAIN_STEPS);
			// Ease-out: fast at first, settle at the end (peak-end relief).
			const eased = 1 - (1 - t) ** 2;
			this.displayUsed = start + (end - start) * eased;
			this.opts.requestRender();
			if (step < DRAIN_STEPS) {
				this.timers.push(setTimeout(tick, DRAIN_STEP_MS));
				return;
			}
			this.displayUsed = end;
			this.beginCelebrate();
		};
		this.timers.push(setTimeout(tick, DRAIN_STEP_MS));
	}

	render(width: number): string[] {
		const { store, dimStyle, style, warnStyle, errorStyle } = this.opts;
		const s = store.get();
		const modelShort = s.modelId.split("/").pop()?.split(" ")[0] ?? s.modelId;
		const path = shortPath(this.opts.cwd);
		const branchPart = this.branch ? ` (${this.branch})` : "";
		const left = dimStyle(truncateToWidth(`${path}${branchPart}`, Math.max(10, Math.floor(width * 0.28)), "…"));

		const ctx = this.renderContextBar(s.contextWindow, width, style, warnStyle, errorStyle, dimStyle);

		const rightParts: string[] = [];
		for (const value of this.statuses.values()) {
			if (value) rightParts.push(style(value));
		}
		rightParts.push(style(modelShort));
		if (this.opts.blueprintName) rightParts.push(dimStyle(`[${this.opts.blueprintName}]`));
		if (this.opts.updateAvailable) {
			rightParts.push(warnStyle(`↑ ${this.opts.updateAvailable.version}`));
		}
		if (this.hint) rightParts.push(dimStyle(this.hint));
		const right = rightParts.join(dimStyle(" · "));

		const sep = dimStyle("  ");
		const pieces = [left, ctx, right].filter((part) => part.length > 0);
		const joined = pieces.join(sep);
		if (visibleWidth(joined) <= width) {
			if (!ctx) return [joined];
			// Pin context bar as the visual center: path left, ctx mid, meta right.
			const mid = ctx;
			const leftW = visibleWidth(left);
			const midW = visibleWidth(mid);
			const rightW = visibleWidth(right);
			const gaps = width - leftW - midW - rightW;
			if (gaps >= 2) {
				const leftGap = Math.floor(gaps / 2);
				const rightGap = gaps - leftGap;
				return [left + " ".repeat(leftGap) + mid + " ".repeat(rightGap) + right];
			}
			return [truncateToWidth(joined, width, "…")];
		}
		return [truncateToWidth(joined, width, "…")];
	}

	setUpdateAvailable(version: string): void {
		this.opts.updateAvailable = { version };
		this.opts.requestRender();
	}

	/** Test/inspection: current compaction animation phase. */
	get compactPhase(): CompactPhase {
		return this.phase;
	}

	/** Test/inspection: animated context-used value. */
	get animatedContextUsed(): number {
		return this.displayUsed;
	}

	private renderContextBar(
		contextWindow: number,
		width: number,
		style: (s: string) => string,
		warnStyle: (s: string) => string,
		errorStyle: (s: string) => string,
		dimStyle: (s: string) => string,
	): string {
		if (contextWindow <= 0) return "";

		const used = this.phase === "idle" ? this.opts.store.get().contextUsed : this.displayUsed;
		const fill = contextWindow > 0 ? Math.min(used / contextWindow, 1) : 0;
		// Compact fill — counts carry the precision; bar is a glanceable spark only.
		const barWidth = Math.min(Math.max(Math.floor(width * 0.06), 4), 8);
		const pb = new ProgressBar({ value: used, max: contextWindow });
		const bar = pb.format(barWidth);
		const colorFn =
			fill > CONTEXT_FILL_ERROR
				? errorStyle
				: fill > CONTEXT_FILL_WARN
					? warnStyle
					: fill > CONTEXT_FILL_ACCENT
						? style
						: dimStyle;

		const label = this.phase === "compacting" ? "compact" : "ctx";
		const counts = `${fmtTokens(used)}/${fmtTokens(contextWindow)}`;

		// Von Restorff: diverge from steady chrome via blink / phase label — not color alone.
		if ((this.phase === "compacting" || this.phase === "celebrate") && !this.blinkOn) {
			return dimStyle(`${label} ${"░".repeat(barWidth)} ${counts}`);
		}
		if (this.phase === "compacting") {
			return `${warnStyle(label)} ${colorFn(bar)} ${dimStyle(counts)}`;
		}
		if (this.phase === "celebrate" || this.phase === "draining") {
			return `${style(label)} ${colorFn(bar)} ${dimStyle(counts)}`;
		}
		const compactSuffix = this.opts.store.get().compacted ? dimStyle(" · compacted") : "";
		return `${dimStyle(label)} ${colorFn(bar)} ${dimStyle(counts)}${compactSuffix}`;
	}

	private beginCelebrate(): void {
		this.phase = "celebrate";
		this.blinkOn = true;
		this.opts.requestRender();
		if (this.reducedMotion) {
			this.phase = "idle";
			this.blinkOn = true;
			this.opts.requestRender();
			return;
		}
		let n = 0;
		const pulse = (): void => {
			n++;
			this.blinkOn = !this.blinkOn;
			this.opts.requestRender();
			if (n < CELEBRATE_BLINKS) {
				this.timers.push(setTimeout(pulse, BLINK_MS));
				return;
			}
			this.phase = "idle";
			this.blinkOn = true;
			this.displayUsed = this.opts.store.get().contextUsed;
			this.opts.requestRender();
		};
		this.timers.push(setTimeout(pulse, BLINK_MS));
	}

	private scheduleBlinkLoop(): void {
		const pulse = (): void => {
			if (this.phase !== "compacting") return;
			this.blinkOn = !this.blinkOn;
			this.opts.requestRender();
			this.timers.push(setTimeout(pulse, BLINK_MS));
		};
		this.timers.push(setTimeout(pulse, BLINK_MS));
	}

	private clearTimers(): void {
		for (const timer of this.timers) clearTimeout(timer);
		this.timers = [];
	}
}
