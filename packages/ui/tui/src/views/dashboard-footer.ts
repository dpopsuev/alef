import { execSync } from "node:child_process";
import type { Component } from "../component.js";
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

/**
 *
 */
export type FooterPanel = DashboardFooter;

/**
 * Hint-first footer: path/model + key tips. Dense token/ctx stats live under :tokens / :status.
 */
export class DashboardFooter implements Component {
	private readonly opts: DashboardFooterOptions;
	private readonly branch: string | undefined;
	private unsub: (() => void) | undefined;
	private readonly statuses = new Map<string, string>();
	private hint = ": for commands · Tab inspect agents";

	constructor(opts: DashboardFooterOptions) {
		this.opts = opts;
		this.branch = getGitBranch(opts.cwd);
		this.unsub = opts.store.subscribe(() => {
			opts.requestRender();
		});
	}

	invalidate(): void {}

	dispose(): void {
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

	render(width: number): string[] {
		const { store, dimStyle, style, warnStyle } = this.opts;
		const s = store.get();
		const modelShort = s.modelId.split("/").pop()?.split(" ")[0] ?? s.modelId;
		const path = shortPath(this.opts.cwd);
		const branchPart = this.branch ? ` (${this.branch})` : "";
		const left = dimStyle(truncateToWidth(`${path}${branchPart}`, Math.max(12, Math.floor(width * 0.35)), "…"));

		const rightParts: string[] = [];
		for (const value of this.statuses.values()) {
			if (value) rightParts.push(style(value));
		}
		rightParts.push(style(modelShort));
		if (this.opts.blueprintName) rightParts.push(dimStyle(`[${this.opts.blueprintName}]`));
		if (this.opts.updateAvailable) {
			rightParts.push(warnStyle(`↑ ${this.opts.updateAvailable.version}`));
		}
		rightParts.push(dimStyle(this.hint));

		const right = rightParts.join(dimStyle(" · "));
		const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
		if (visibleWidth(left) + visibleWidth(right) + 1 > width) {
			return [truncateToWidth(`${left} ${right}`, width, "…")];
		}
		return [left + " ".repeat(gap) + right];
	}

	setUpdateAvailable(version: string): void {
		this.opts.updateAvailable = { version };
		this.opts.requestRender();
	}
}
