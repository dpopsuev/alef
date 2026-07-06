/**
 *
 */
export type SemanticColor = "success" | "warning" | "error" | "info" | "muted" | "accent" | "default";

export const TRAFFIC_LIGHT = {
	good: "success" as SemanticColor,
	working: "warning" as SemanticColor,
	bad: "error" as SemanticColor,
} as const;

/**
 *
 */
export type StatusLevel = "done" | "active" | "error" | "pending" | "pruned" | "deferred";

/**
 *
 */
export interface StatusStyle {
	glyph: string;
	color: SemanticColor;
}

const STATUS_MAP: Record<StatusLevel, StatusStyle> = {
	done: { glyph: "■", color: "muted" },
	active: { glyph: "●", color: "accent" },
	error: { glyph: "▲", color: "error" },
	pending: { glyph: "○", color: "default" },
	pruned: { glyph: "×", color: "muted" },
	deferred: { glyph: "◇", color: "muted" },
};

/**
 *
 */
export function statusStyle(status: StatusLevel): StatusStyle {
	return STATUS_MAP[status];
}

/**
 *
 */
export function statusGlyph(status: StatusLevel): string {
	return STATUS_MAP[status].glyph;
}

export const DEPTH_SEPARATOR = {
	0: "━",
	1: "─",
	2: "┄",
	3: "╌",
} as const;

/**
 *
 */
export function separatorForDepth(depth: number): string {
	if (depth <= 0) return DEPTH_SEPARATOR[0];
	if (depth === 1) return DEPTH_SEPARATOR[1];
	if (depth === 2) return DEPTH_SEPARATOR[2];
	return DEPTH_SEPARATOR[3];
}
