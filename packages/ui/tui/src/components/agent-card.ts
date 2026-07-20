import type { Component } from "../component.js";
import { truncateToWidth } from "../utils.js";
import { INDENT, SPACING } from "../views/layout-constants.js";
import { formatToolArgs } from "../views/tool-view.js";

/**
 *
 */
export interface AgentCardTheme {
	primary: (s: string) => string;
	secondary: (s: string) => string;
	muted: (s: string) => string;
	accent: (s: string) => string;
	identity: (s: string) => string;
}

/**
 *
 */
export interface AgentCardState {
	name: string;
	keyArg: string;
	args: Record<string, unknown>;
	address?: string;
	modelId?: string;
	elapsedMs: number;
	inputTokens: number;
	outputTokens: number;
	tokenDisplay?: string;
	lastChunk: string;
	spinner: string;
	children: ReadonlyArray<{
		id: string;
		name: string;
		keyArg: string;
		args: Record<string, unknown>;
		elapsedMs: number;
		depth: number;
		spinner: string;
	}>;
}

/**
 *
 */
export class AgentCard implements Component {
	private _focused = false;
	private _dimmed = false;
	private _state: AgentCardState;
	private readonly theme: AgentCardTheme;

	constructor(theme: AgentCardTheme, initial: AgentCardState) {
		this.theme = theme;
		this._state = initial;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(v: boolean) {
		this._focused = v;
	}

	get dimmed(): boolean {
		return this._dimmed;
	}

	set dimmed(v: boolean) {
		this._dimmed = v;
	}

	update(state: Partial<AgentCardState>): void {
		this._state = { ...this._state, ...state };
	}

	invalidate(): void {}

	render(width: number): string[] {
		const s = this._state;
		const t = this.theme;
		const wrap = this._dimmed ? t.muted : (x: string) => x;

		const row1 = truncateToWidth(this.renderIdentityRow(s, t, wrap), width, "…");
		// Collapsed by default — Tab focus reveals chunk/budget/children.
		if (!this._focused) return [row1];

		const lines = [row1];
		const row2 = this.renderChunkRow(s, t, width);
		const row3 = this.renderBudgetRow(s, t, wrap);
		if (row2) lines.push(row2);
		if (row3) lines.push(truncateToWidth(row3, width, "…"));

		for (const child of s.children) {
			const indent = " ".repeat(INDENT.CARD_DEPTH_STEP * (child.depth + 1));
			const childCommand = child.name + formatToolArgs(child.args);
			lines.push(truncateToWidth(wrap(`${indent}${child.spinner} ${t.secondary(childCommand)}`), width, "…"));
		}

		return lines;
	}

	private renderIdentityRow(s: AgentCardState, t: AgentCardTheme, wrap: (s: string) => string): string {
		const commandStr = s.name + formatToolArgs(s.args);
		const parts = this._focused
			? [t.accent(">"), s.spinner, t.primary(commandStr)]
			: [s.spinner, t.identity(commandStr)];
		if (s.address) parts.push(t.identity(s.address));
		const modelShort = s.modelId?.split("/").pop()?.split(" ")[0];
		if (modelShort) parts.push(this._focused ? t.secondary(modelShort) : t.muted(modelShort));
		parts.push(this._focused ? t.secondary(fmtMs(s.elapsedMs)) : t.muted(fmtMs(s.elapsedMs)));
		if (!this._focused && s.children.length > 0) {
			parts.push(t.muted(`· ${s.children.length} tool${s.children.length === 1 ? "" : "s"}`));
		}
		const gap = " ".repeat(SPACING.CARD_GAP);
		return wrap(parts.join(gap));
	}

	private renderChunkRow(s: AgentCardState, t: AgentCardTheme, width: number): string {
		if (!this._focused || !s.lastChunk) return "";

		const pad = " ".repeat(SPACING.CARD_GAP);
		const maxW = Math.max(10, width - SPACING.CARD_GAP);
		return `${pad}${t.secondary(truncateToWidth(s.lastChunk, maxW, "…"))}`;
	}

	private renderBudgetRow(s: AgentCardState, t: AgentCardTheme, wrap: (s: string) => string): string {
		if (s.inputTokens <= 0) return "";
		const pad = " ".repeat(SPACING.CARD_GAP);
		if (s.tokenDisplay) return wrap(`${pad}${s.tokenDisplay}`);
		const colorFn = this._focused ? t.secondary : t.muted;
		return wrap(`${pad}${colorFn(`↑${fmtCompact(s.inputTokens)} ↓${fmtCompact(s.outputTokens)}`)}`);
	}
}

/**
 *
 */
function fmtMs(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	const rem = Math.round(s % 60);
	return `${m}m ${rem}s`;
}

/**
 *
 */
function fmtCompact(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}
