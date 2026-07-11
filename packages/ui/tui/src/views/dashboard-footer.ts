import { execSync } from "node:child_process";
import type { Component } from "../component.js";
import { ProgressBar } from "../components/progress-bar.js";
import { numericInterpolator, SlotMachine } from "../components/slot-machine.js";
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
	buildInfo?: { version: string; gitHash: string; gitCommitDate?: string };
}

/**
 *
 */
function fmtTokens(n: number): string {
	if (n === 0) return "0";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
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

/**
 *
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function renderContextBar(
	used: number,
	total: number,
	barWidth: number,
	style: (s: string) => string,
	warnStyle: (s: string) => string,
	errorStyle: (s: string) => string,
	dimStyle: (s: string) => string,
): string {
	if (total <= 0 || used <= 0) return "";
	const fill = Math.min(used / total, 1);
	const pb = new ProgressBar({ value: used, max: total });
	const bar = pb.format(barWidth);
	const label = `${fmtTokens(used)}/${fmtTokens(total)}`;
	const colorFn =
		fill > CONTEXT_FILL_ERROR
			? errorStyle
			: fill > CONTEXT_FILL_WARN
				? warnStyle
				: fill > CONTEXT_FILL_ACCENT
					? style
					: dimStyle;
	return `ctx ${colorFn(bar)} ${dimStyle(label)}`;
}

/**
 *
 */
export type FooterPanel = DashboardFooter;

/**
 *
 */
export class DashboardFooter implements Component {
	private readonly opts: DashboardFooterOptions;
	private readonly branch: string | undefined;
	private unsub: (() => void) | undefined;
	private readonly inputSlot: SlotMachine<number>;
	private readonly outputSlot: SlotMachine<number>;
	private readonly costSlot: SlotMachine<number>;
	private readonly ctxUsedSlot: SlotMachine<number>;
	private readonly ctxTotalSlot: SlotMachine<number>;

	constructor(opts: DashboardFooterOptions) {
		this.opts = opts;
		this.branch = getGitBranch(opts.cwd);
		this.unsub = opts.store.subscribe(() => {
			const s = opts.store.get();
			this.inputSlot.set(s.inputTokens);
			this.outputSlot.set(s.outputTokens);
			this.costSlot.set(s.costUsd);
			this.ctxUsedSlot.set(s.contextUsed);
			this.ctxTotalSlot.set(s.contextWindow);
			opts.requestRender();
		});
		const tuiHandle = { requestRender: opts.requestRender, terminal: { rows: 24 } };
		const slotOpts = {
			format: fmtTokens,
			interpolate: numericInterpolator,
			style: opts.dimStyle,
			dimStyle: (s: string) => opts.dimStyle(s),
		};
		this.inputSlot = new SlotMachine(tuiHandle, 0, { ...slotOpts, prefix: "↑" });
		this.outputSlot = new SlotMachine(tuiHandle, 0, { ...slotOpts, prefix: "↓" });
		this.costSlot = new SlotMachine(tuiHandle, 0, {
			format: (n: number) => `$${n.toFixed(4)}`,
			interpolate: numericInterpolator,
			style: opts.dimStyle,
			dimStyle: (s: string) => opts.dimStyle(s),
		});
		this.ctxUsedSlot = new SlotMachine(tuiHandle, 0, slotOpts);
		this.ctxTotalSlot = new SlotMachine(tuiHandle, opts.store.get().contextWindow, slotOpts);
	}

	invalidate(): void {}

	dispose(): void {
		this.unsub?.();
		this.inputSlot.dispose();
		this.outputSlot.dispose();
		this.costSlot.dispose();
		this.ctxUsedSlot.dispose();
		this.ctxTotalSlot.dispose();
	}

	render(width: number): string[] {
		const { store, dimStyle, style, warnStyle, errorStyle } = this.opts;
		const s = store.get();
		const modelShort = s.modelId.split("/").pop()?.split(" ")[0] ?? s.modelId;

		const path = shortPath(this.opts.cwd);
		const branchPart = this.branch ? ` (${this.branch})` : "";
		const pathLine = dimStyle(truncateToWidth(`${path}${branchPart}`, width, "…"));

		const segments: string[] = [];

		segments.push(`${this.inputSlot.currentStyled()} ${this.outputSlot.currentStyled()} ${this.costSlot.currentStyled()}`);

		if (s.contextWindow > 0) {
			const barWidth = Math.min(Math.max(Math.floor(width * 0.1), 6), 20);
			const compactSuffix = s.compacted ? dimStyle(" (auto)") : "";
			const fill = s.contextUsed > 0 ? Math.min(s.contextUsed / s.contextWindow, 1) : 0;
			const pb = new ProgressBar({ value: s.contextUsed, max: s.contextWindow });
			const bar = pb.format(barWidth);
			const colorFn =
				fill > CONTEXT_FILL_ERROR ? errorStyle
				: fill > CONTEXT_FILL_WARN ? warnStyle
				: fill > CONTEXT_FILL_ACCENT ? style
				: dimStyle;
			const ctxLabel = `${this.ctxUsedSlot.currentStyled()}/${this.ctxTotalSlot.currentStyled()}`;
			segments.push(`ctx ${colorFn(bar)} ${ctxLabel}${compactSuffix}`);
		}

		const thinkingSuffix = s.thinkingLevel && s.thinkingLevel !== "none" ? ` (${s.thinkingLevel})` : "";
		segments.push(style(`${modelShort}${thinkingSuffix}`));

		if (this.opts.blueprintName) {
			segments.push(dimStyle(`[${this.opts.blueprintName}]`));
		}

		if (this.opts.buildInfo) {
			const { version, gitHash, gitCommitDate } = this.opts.buildInfo;
			// For dev builds, include commit date in format: v{version}@{hash} ({date})
			// For released versions, use format: v{version}@{hash}
			const versionStr = version === "dev" && gitCommitDate && gitCommitDate !== "unknown"
				? `v${version}@${gitHash} (${gitCommitDate})`
				: `v${version}@${gitHash}`;
			segments.push(dimStyle(versionStr));
		}

		const statsLine = segments.join(dimStyle("  "));
		const statsWidth = visibleWidth(statsLine);

		if (statsWidth + visibleWidth(pathLine) + 4 <= width) {
			const gap = width - statsWidth - visibleWidth(pathLine);
			return [pathLine + " ".repeat(gap) + statsLine];
		}

		return [pathLine, statsLine];
	}
}
