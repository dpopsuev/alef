import { execSync } from "node:child_process";
import type { Component } from "@dpopsuev/alef-tui";
import { truncateToWidth, visibleWidth } from "@dpopsuev/alef-tui";

export interface DashboardFooterOptions {
	sessionId: string;
	modelId: string;
	cwd: string;
	getTokensTotal: () => number;
	style: (text: string) => string;
	dimStyle: (text: string) => string;
}

function fmtTokens(n: number): string {
	if (n === 0) return "";
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
		const { sessionId, modelId, dimStyle, style } = this.opts;
		const tokens = fmtTokens(this.opts.getTokensTotal());
		const modelShort = modelId.split("/").pop()?.split(" ")[0] ?? modelId;
		const sessionShort = sessionId.slice(0, 8);

		const path = shortPath(this.opts.cwd);
		const branchPart = this.branch ? ` (${this.branch})` : "";
		const pathLine = dimStyle(truncateToWidth(`${path}${branchPart}`, width, "…"));

		const segments: string[] = [style(sessionShort), dimStyle(modelShort)];
		if (tokens) segments.push(dimStyle(`${tokens} tok`));

		const statsLine = segments.join(dimStyle("  │  "));
		const statsWidth = visibleWidth(statsLine);

		if (statsWidth + visibleWidth(pathLine) + 4 <= width) {
			const gap = width - statsWidth - visibleWidth(pathLine);
			return [pathLine + " ".repeat(gap) + statsLine];
		}

		return [pathLine, statsLine];
	}
}
