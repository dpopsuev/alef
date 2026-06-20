import { execSync } from "node:child_process";
import type { Component } from "@dpopsuev/alef-tui";
import { truncateToWidth, visibleWidth } from "@dpopsuev/alef-tui";

export interface DashboardFooterOptions {
	sessionId: string;
	modelId: string;
	cwd: string;
	getInputTokens: () => number;
	getOutputTokens: () => number;
	getContextWindow: () => number;
	getContextUsed: () => number;
	getThinkingLevel: () => string;
	getCompacted: () => boolean;
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

export class DashboardFooter implements Component {
	private opts: DashboardFooterOptions;
	private branch: string | undefined;

	constructor(opts: DashboardFooterOptions) {
		this.opts = opts;
		this.branch = getGitBranch(opts.cwd);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const { modelId, dimStyle, style, warnStyle, errorStyle } = this.opts;
		const modelShort = modelId.split("/").pop()?.split(" ")[0] ?? modelId;

		const path = shortPath(this.opts.cwd);
		const branchPart = this.branch ? ` (${this.branch})` : "";
		const pathLine = dimStyle(truncateToWidth(`${path}${branchPart}`, width, "…"));

		const inputTok = this.opts.getInputTokens();
		const outputTok = this.opts.getOutputTokens();
		const contextWindow = this.opts.getContextWindow();
		const contextUsed = this.opts.getContextUsed();
		const thinking = this.opts.getThinkingLevel();

		const segments: string[] = [];

		if (inputTok > 0 || outputTok > 0) {
			segments.push(dimStyle(`↑${fmtTokens(inputTok)} ↓${fmtTokens(outputTok)}`));
		}

		if (contextWindow > 0 && contextUsed > 0) {
			const fill = contextUsed / contextWindow;
			const pct = `${Math.round(fill * 100)}%`;
			const autoSuffix = this.opts.getCompacted() ? " (auto)" : "";
			const ctxText = `ctx ${pct}${autoSuffix}`;
			if (fill > 0.9) {
				segments.push(errorStyle(ctxText));
			} else if (fill > 0.7) {
				segments.push(warnStyle(ctxText));
			} else {
				segments.push(dimStyle(ctxText));
			}
		}

		const thinkingSuffix = thinking && thinking !== "none" ? ` (${thinking})` : "";
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
