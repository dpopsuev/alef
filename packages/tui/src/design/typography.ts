import { SEPARATOR } from "./chars.js";

export type SeparatorWeight = "thick" | "thin" | "dotted" | "dashed";

const WEIGHT_MAP: Record<SeparatorWeight, string> = {
	thick: SEPARATOR.thick,
	thin: SEPARATOR.thin,
	dotted: SEPARATOR.dotted,
	dashed: SEPARATOR.dashed,
};

export function separator(width: number, weight: SeparatorWeight = "thin"): string {
	return WEIGHT_MAP[weight].repeat(width);
}

export function labeledSeparator(label: string, width: number, weight: SeparatorWeight = "thin"): string {
	const char = WEIGHT_MAP[weight];
	const text = ` ${label} `;
	const remaining = Math.max(0, width - text.length - 1);
	return `${char}${text}${char.repeat(remaining)}`;
}

export function badge(n: number): string {
	if (n === 0) return "0";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

export function progressBar(ratio: number, width: number): string {
	const clamped = Math.max(0, Math.min(1, ratio));
	const filled = Math.round(clamped * width);
	return "█".repeat(filled) + "░".repeat(width - filled);
}

export function sparkline(values: number[], width: number): string {
	if (values.length === 0) return " ".repeat(width);
	const max = Math.max(...values);
	const min = Math.min(...values);
	const range = max - min || 1;
	const bars = "▁▂▃▄▅▆▇█";
	const sampled =
		values.length > width
			? values.filter((_, i) => i % Math.ceil(values.length / width) === 0).slice(0, width)
			: values;
	return sampled.map((v) => bars[Math.round(((v - min) / range) * 7)] ?? bars[0]).join("");
}
