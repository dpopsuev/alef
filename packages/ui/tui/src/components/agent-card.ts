import type { Component } from "../component.js";
import { truncateToWidth } from "../utils.js";

export interface AgentCardTheme {
	primary: (s: string) => string;
	secondary: (s: string) => string;
	muted: (s: string) => string;
	accent: (s: string) => string;
	identity: (s: string) => string;
}

export interface AgentCardState {
	name: string;
	keyArg: string;
	address?: string;
	modelId?: string;
	elapsedMs: number;
	inputTokens: number;
	outputTokens: number;
	lastChunk: string;
	expandedChunks: readonly string[];
	spinner: string;
	children: ReadonlyArray<{
		id: string;
		name: string;
		keyArg: string;
		elapsedMs: number;
		depth: number;
		spinner: string;
	}>;
}

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

		const row1 = this.renderIdentityRow(s, t, wrap);
		const row2 = this.renderChunkRow(s, t, width);
		const row3 = this.renderBudgetRow(s, t, wrap);

		const lines = [row1];
		if (row2) lines.push(row2);
		if (row3) lines.push(row3);

		for (const child of s.children) {
			const indent = "  ".repeat(child.depth + 1);
			lines.push(wrap(`${indent}${child.spinner} ${t.secondary(child.name)}  ${t.muted(child.keyArg)}`));
		}

		return lines;
	}

	private renderIdentityRow(s: AgentCardState, t: AgentCardTheme, wrap: (s: string) => string): string {
		const marker = this._focused ? t.accent(">") : " ";
		const parts = [marker, s.spinner, this._focused ? t.primary(s.name) : t.identity(s.name)];
		if (s.address) parts.push(t.identity(s.address));
		const modelShort = s.modelId?.split("/").pop()?.split(" ")[0];
		if (modelShort) parts.push(this._focused ? t.secondary(modelShort) : t.muted(modelShort));
		parts.push(this._focused ? t.secondary(fmtMs(s.elapsedMs)) : t.muted(fmtMs(s.elapsedMs)));
		return wrap(parts.join("  "));
	}

	private renderChunkRow(s: AgentCardState, t: AgentCardTheme, width: number): string {
		const pad = "     ";
		const maxW = Math.max(10, width - 6);
		const colorFn = this._focused ? t.identity : t.muted;

		if (this._focused && s.expandedChunks.length > 0) {
			const maxLines = 6;
			const tail = s.expandedChunks.slice(-maxLines);
			return tail.map((l) => `${pad}${colorFn(truncateToWidth(l, maxW, "…"))}`).join("\n");
		}

		if (s.lastChunk) {
			return `${pad}${colorFn(truncateToWidth(s.lastChunk, maxW, "…"))}`;
		}

		return "";
	}

	private renderBudgetRow(s: AgentCardState, t: AgentCardTheme, wrap: (s: string) => string): string {
		if (s.inputTokens <= 0) return "";
		const colorFn = this._focused ? t.secondary : t.muted;
		return wrap(`     ${colorFn(`↑${fmtCompact(s.inputTokens)} ↓${fmtCompact(s.outputTokens)}`)}`);
	}
}

function fmtMs(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	const rem = Math.round(s % 60);
	return `${m}m ${rem}s`;
}

function fmtCompact(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}
