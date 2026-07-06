/**
 *
 */
export interface BoxSet {
	readonly horizontal: string;
	readonly vertical: string;
	readonly topLeft: string;
	readonly topRight: string;
	readonly bottomLeft: string;
	readonly bottomRight: string;
	readonly leftTee: string;
	readonly rightTee: string;
	readonly topTee: string;
	readonly bottomTee: string;
	readonly cross: string;
}

const boxSet = (
	horizontal: string,
	vertical: string,
	topLeft: string,
	topRight: string,
	bottomLeft: string,
	bottomRight: string,
	leftTee: string,
	rightTee: string,
	topTee: string,
	bottomTee: string,
	cross: string,
): BoxSet => ({
	horizontal,
	vertical,
	topLeft,
	topRight,
	bottomLeft,
	bottomRight,
	leftTee,
	rightTee,
	topTee,
	bottomTee,
	cross,
});

export const BOX = {
	light: boxSet("─", "│", "┌", "┐", "└", "┘", "├", "┤", "┬", "┴", "┼"),
	heavy: boxSet("━", "┃", "┏", "┓", "┗", "┛", "┣", "┫", "┳", "┻", "╋"),
	double: boxSet("═", "║", "╔", "╗", "╚", "╝", "╠", "╣", "╦", "╩", "╬"),
	rounded: boxSet("─", "│", "╭", "╮", "╰", "╯", "├", "┤", "┬", "┴", "┼"),
} as const;

export const BLOCK = {
	full: "█",
	dark: "▓",
	medium: "▒",
	light: "░",
	upper: "▀",
	lower: "▄",
	left: "▌",
	right: "▐",
	fractional: ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const,
} as const;

export const GEO = {
	circleFilled: "●",
	circleEmpty: "○",
	squareFilled: "■",
	squareEmpty: "□",
	triangleUp: "▲",
	triangleDown: "▼",
	triangleRight: "▸",
	triangleLeft: "◄",
	diamond: "◆",
	diamondEmpty: "◇",
	cross: "×",
	check: "✓",
	bullet: "▪",
	dot: "·",
	ellipsis: "…",
	arrowRight: "→",
	arrowLeft: "←",
	arrowUp: "↑",
	arrowDown: "↓",
} as const;

export const TREE = {
	branch: "├── ",
	last: "└── ",
	pipe: "│   ",
	space: "    ",
} as const;

export const SEPARATOR = {
	thin: "─",
	thick: "━",
	double: "═",
	dotted: "┄",
	dashed: "╌",
} as const;
