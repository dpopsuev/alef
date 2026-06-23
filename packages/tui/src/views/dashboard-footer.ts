import { execSync } from "node:child_process";
import type { Component } from "../component.js";
import { truncateToWidth, visibleWidth } from "../utils.js";
import type { TuiStateStore } from "./state.js";

export interface DashboardFooterOptions {
	sessionId: string;
	cwd: string;
	store: TuiStateStore;
	requestRender: () => void;
	style: (text: string) => string;
	dimStyle: (text: string) => string;
	warnStyle: (text: string) => string;
	errorStyle: (text: string) => string;
}

function fmtTokens(n: number): string {
	if (n === 0) return "0";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function shortPath(cwd: string): string {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	if (home && cwd.startsWith(home)) return `~${cwd.slice(home.length)}`;
	return cwd;
}

function getGitBranch(cwd: string): string | undefined {
	try {
		return execSync("git rev-parse --abbrev-ref HEAD 2>/dev/null", { cwd, encoding: "utf-8" }).trim() || undefined;
	} catch {
		return undefined;
	}
}

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
	const filled = Math.round(fill * barWidth);
	const empty = barWidth - filled;
	const bar = "█".repeat(filled) + "░".repeat(empty);
	const label = `${fmtTokens(used)}/${fmtTokens(total)}`;
	const colorFn = fill > 0.9 ? errorStyle : fill > 0.7 ? warnStyle : fill > 0.5 ? style : dimStyle;
	const autoSuffix = "";
	return `ctx ${colorFn(bar)} ${dimStyle(label)}${autoSuffix}`;
}

export type FooterPanel = DashboardFooter;

export class DashboardFooter implements Component {
	private readonly opts: DashboardFooterOptions;
	private readonly branch: string | undefined;
	private unsub: (() => void) | undefined;

	constructor(opts: DashboardFooterOptions) {
		this.opts = opts;
		this.branch = getGitBranch(opts.cwd);
		this.unsub = opts.store.subscribe(() => opts.requestRender());
	}

	invalidate(): void {}

	dispose(): void {
		this.unsub?.();
	}

	render(width: number): string[] {
		const { store, dimStyle, style, warnStyle, errorStyle } = this.opts;
		const s = store.get();
		const modelShort = s.modelId.split("/").pop()?.split(" ")[0] ?? s.modelId;

		const path = shortPath(this.opts.cwd);
		const branchPart = this.branch ? ` (${this.branch})` : "";
		const pathLine = dimStyle(truncateToWidth(`${path}${branchPart}`, width, "…"));

		const segments: string[] = [];

		if (s.inputTokens > 0 || s.outputTokens > 0) {
			segments.push(dimStyle(`↑${fmtTokens(s.inputTokens)} ↓${fmtTokens(s.outputTokens)}`));
		}

		if (s.contextWindow > 0 && s.contextUsed > 0) {
			const barWidth = Math.min(Math.max(Math.floor(width * 0.1), 6), 20);
			const compactSuffix = s.compacted ? dimStyle(" (auto)") : "";
			segments.push(
				renderContextBar(s.contextUsed, s.contextWindow, barWidth, style, warnStyle, errorStyle, dimStyle) +
					compactSuffix,
			);
		}

		const thinkingSuffix = s.thinkingLevel && s.thinkingLevel !== "none" ? ` (${s.thinkingLevel})` : "";
		segments.push(style(`${modelShort}${thinkingSuffix}`));

		const statsLine = segments.join(dimStyle("  "));
		const statsWidth = visibleWidth(statsLine);

		if (statsWidth + visibleWidth(pathLine) + 4 <= width) {
			const gap = width - statsWidth - visibleWidth(pathLine);
			return [pathLine + " ".repeat(gap) + statsLine];
		}

		return [pathLine, statsLine];
	}
}
