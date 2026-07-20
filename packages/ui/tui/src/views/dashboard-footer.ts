import { execSync } from "node:child_process";
import type { Component } from "../component.js";
import { ProgressBar } from "../components/progress-bar.js";
import { truncateToWidth } from "../utils.js";
import type { FooterContainer, FooterElement } from "./footer-layout.js";
import { layoutFooter } from "./footer-layout.js";
import type { TuiStateStore } from "./state.js";

/**
 * Options for creating the dashboard footer.
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

/** Format a token count compactly (e.g. 1.2M, 45k, 800). */
function fmtTokens(n: number): string {
	if (n <= 0) return "0";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(Math.round(n));
}

/** Replace $HOME prefix with ~ for compact display. */
function shortPath(cwd: string): string {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	if (home && cwd.startsWith(home)) return `~${cwd.slice(home.length)}`;
	return cwd;
}

/** Read the current git branch name, or undefined if not in a repo. */
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

/** Re-export for backward compatibility. */
export type FooterPanel = DashboardFooter;

/**
 * Composable dashboard footer using the footer-layout engine.
 *
 * Layout: Repo[path, branch] · Alef[blueprint] ... AI[ctx, model]
 * Containers and sections are declarative -- move a container by changing its section field.
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

	setUpdateAvailable(version: string): void {
		this.opts.updateAvailable = { version };
		this.opts.requestRender();
	}

	get compactPhase(): CompactPhase {
		return this.phase;
	}

	get animatedContextUsed(): number {
		return this.displayUsed;
	}

	// ── Render via layout engine ──────────────────────────────────────

	render(width: number): string[] {
		const { dimStyle } = this.opts;
		const sep = dimStyle(" \u00b7 ");
		const { elements, containers } = this.buildLayout(width);
		const line = layoutFooter(containers, elements, width, sep);
		return [line];
	}

	/** Build the element registry and container list for the current state. */
	private buildLayout(width: number): { elements: Map<string, FooterElement>; containers: FooterContainer[] } {
		const { store, dimStyle, style, warnStyle, errorStyle } = this.opts;
		const s = store.get();
		const elements = new Map<string, FooterElement>();

		// ── Repo container (left) ────────────────────────────────────
		const path = shortPath(this.opts.cwd);
		const branchPart = this.branch ? ` (${this.branch})` : "";
		elements.set("repo.path", {
			id: "repo.path",
			priority: 1,
			render: (maxW) => dimStyle(truncateToWidth(`${path}${branchPart}`, maxW, "\u2026")),
		});

		// ── Alef container (left) ────────────────────────────────────
		if (this.opts.blueprintName) {
			elements.set("alef.blueprint", {
				id: "alef.blueprint",
				priority: 30,
				render: () => dimStyle(`[${shortPath(this.opts.blueprintName!)}]`),
			});
		}

		// ── Status elements (right, high priority) ───────────────────
		for (const [key, value] of this.statuses) {
			elements.set(`status.${key}`, {
				id: `status.${key}`,
				priority: 5,
				render: () => style(value),
			});
		}

		// ── AI container (right) ─────────────────────────────────────
		const ctxBar = this.renderContextBar(s.contextWindow, width, style, warnStyle, errorStyle, dimStyle);
		if (ctxBar) {
			elements.set("ai.context", {
				id: "ai.context",
				priority: 10,
				render: () => ctxBar,
			});
		}

		const modelShort = s.modelId.split("/").pop()?.split(" ")[0] ?? s.modelId;
		elements.set("ai.model", {
			id: "ai.model",
			priority: 2,
			render: () => style(modelShort + (s.thinkingLevel && s.thinkingLevel !== "off" ? ` (${s.thinkingLevel})` : "")),
		});

		if (this.opts.updateAvailable) {
			const ver = this.opts.updateAvailable.version;
			elements.set("ai.update", {
				id: "ai.update",
				priority: 20,
				render: () => warnStyle(`\u2191 ${ver}`),
			});
		}

		if (this.hint) {
			elements.set("ai.hint", {
				id: "ai.hint",
				priority: 40,
				render: () => dimStyle(this.hint),
			});
		}

		// ── Containers ───────────────────────────────────────────────
		// Moving a container to a different section is a one-field change.
		const containers: FooterContainer[] = [
			{ id: "repo", section: "left", children: ["repo.path"], priority: 1 },
		];

		if (this.opts.blueprintName) {
			containers.push({ id: "alef", section: "left", children: ["alef.blueprint"], priority: 20 });
		}

		const statusIds = [...this.statuses.keys()].map((k) => `status.${k}`);
		if (statusIds.length > 0) {
			containers.push({ id: "status", section: "right", children: statusIds, priority: 5 });
		}

		const aiChildren = ["ai.context", "ai.model"];
		if (this.opts.updateAvailable) aiChildren.push("ai.update");
		if (this.hint) aiChildren.push("ai.hint");
		containers.push({ id: "ai", section: "right", children: aiChildren, priority: 1 });

		return { elements, containers };
	}

	// ── Context bar rendering (unchanged) ────────────────────────────

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
		if ((this.phase === "compacting" || this.phase === "celebrate") && !this.blinkOn) {
			return dimStyle(`${label} ${"\u2591".repeat(barWidth)} ${counts}`);
		}
		if (this.phase === "compacting") {
			return `${warnStyle(label)} ${colorFn(bar)} ${dimStyle(counts)}`;
		}
		if (this.phase === "celebrate" || this.phase === "draining") {
			return `${style(label)} ${colorFn(bar)} ${dimStyle(counts)}`;
		}
		const compactSuffix = this.opts.store.get().compacted ? dimStyle(" \u00b7 compacted") : "";
		return `${dimStyle(label)} ${colorFn(bar)} ${dimStyle(counts)}${compactSuffix}`;
	}

	// ── Animation internals ──────────────────────────────────────────

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
