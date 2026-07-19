/**
 * Bootloader overlay -- shown during startup and hot-reload transitions.
 *
 * Renders the Hebrew Alef letter in box-drawing style with a theme-aware
 * gradient (inspired by pi-startup-header), plus progress steps during
 * BOOTING and a compact spinner during RELOADING.
 */

import type { Component } from "@dpopsuev/alef-tui";
import { visibleWidth } from "@dpopsuev/alef-tui";
import { color, getTheme } from "./theme.js";

const LOGO_LINES = [
	"█████▓         ██████████▓",
	"█████▓         ██████████▓",
	"▀▀▀▀▀█▄▄▄▄▄    ▀▀▀▀▀█████▓",
	"     █████▓         █████▓",
	"     █████▓         █████▓",
	"█████▓    █████▓    █████▓",
	"█████▓    █████▓    █████▓",
	"█████▓    ▀▀▀▀▀█▄▄▄▄█▀▀▀▀▀",
	"█████▓         █████▓",
	"█████▓         █████▓",
	"██████████▓         █████▓",
	"██████████▓         █████▓",
	"▀▀▀▀▀▀▀▀▀▀▀         ▀▀▀▀▀▀",
];

const PALETTE_STEPS = 24;
const MAX_DARKEN = 0.18;
const MAX_LIGHTEN = 0.18;
const ROW_PHASE_STEP = 0.12;
const RESET = "\x1b[0m";

const SPINNER_FRAMES = [
	"\u28CB",
	"\u28D9",
	"\u28F9",
	"\u28F8",
	"\u28FC",
	"\u28F4",
	"\u28E6",
	"\u28E7",
	"\u28C7",
	"\u28CF",
];

type Rgb = [number, number, number];

/** Clamp a color channel to 0-255. */
function clamp(v: number): number {
	return Math.max(0, Math.min(255, Math.round(v)));
}

/** Darken an RGB color by a fraction. */
function darken(rgb: Rgb, amount: number): Rgb {
	return [clamp(rgb[0] * (1 - amount)), clamp(rgb[1] * (1 - amount)), clamp(rgb[2] * (1 - amount))];
}

/** Lighten an RGB color by a fraction. */
function lighten(rgb: Rgb, amount: number): Rgb {
	return [
		clamp(rgb[0] + (255 - rgb[0]) * amount),
		clamp(rgb[1] + (255 - rgb[1]) * amount),
		clamp(rgb[2] + (255 - rgb[2]) * amount),
	];
}

/** Build a cosine-wave palette around the accent color. */
function buildPalette(accent: Rgb): Rgb[] {
	return Array.from({ length: PALETTE_STEPS }, (_, i) => {
		const wave = -Math.cos((i / PALETTE_STEPS) * Math.PI * 2);
		return wave < 0 ? darken(accent, MAX_DARKEN * -wave) : lighten(accent, MAX_LIGHTEN * wave);
	});
}

/** Sample a color from the palette with interpolation. */
function sample(palette: Rgb[], pos: number): Rgb {
	const p = ((pos % 1) + 1) % 1;
	const scaled = p * palette.length;
	const base = Math.floor(scaled) % palette.length;
	const next = (base + 1) % palette.length;
	const f = scaled - Math.floor(scaled);
	const a = palette[base]!;
	const b = palette[next]!;
	return [
		Math.round(a[0] + (b[0] - a[0]) * f),
		Math.round(a[1] + (b[1] - a[1]) * f),
		Math.round(a[2] + (b[2] - a[2]) * f),
	];
}

/** Resolve the accent color to RGB from the theme token. */
function resolveAccentRgb(): Rgb {
	const t = getTheme();
	const token = t.accentFg;
	if (token.truecolor) {
		const hex = token.truecolor.replace("#", "");
		return [
			Number.parseInt(hex.slice(0, 2), 16),
			Number.parseInt(hex.slice(2, 4), 16),
			Number.parseInt(hex.slice(4, 6), 16),
		];
	}
	return [100, 140, 255];
}

/** Render a line of text with per-character gradient coloring. */
function gradientLine(text: string, palette: Rgb[], phase: number): string {
	const chars = [...text];
	const span = Math.max(chars.length - 1, 1);
	return chars
		.map((ch, i) => {
			if (ch === " ") return " ";
			const [r, g, b] = sample(palette, i / span + phase);
			return `\x1b[38;2;${r};${g};${b}m${ch}${RESET}`;
		})
		.join("");
}

/** Boot phase shown as a progress step. */
export interface BootStep {
	label: string;
	status: "pending" | "active" | "done";
}

/** Current bootloader state. */
export type BootPhase = "booting" | "reloading" | "ready";

/**
 * Bootloader component that renders as a TUI overlay.
 */
export class Bootloader implements Component {
	private phase: BootPhase = "booting";
	private steps: BootStep[] = [];
	private frame = 0;
	private statusLine = "";
	private timer: ReturnType<typeof setInterval> | null = null;
	private requestRender: (() => void) | null = null;

	/** Start the animation timer. */
	start(requestRender: () => void): void {
		this.requestRender = requestRender;
		this.timer = setInterval(() => {
			this.frame++;
			this.requestRender?.();
		}, 100);
	}

	/** Stop the animation timer. */
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	setPhase(phase: BootPhase): void {
		this.phase = phase;
	}

	setSteps(steps: BootStep[]): void {
		this.steps = steps;
	}

	setStatus(line: string): void {
		this.statusLine = line;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.phase === "ready") return [];

		const t = getTheme();
		const spinner = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length]!;
		const lines: string[] = [];
		const center = (s: string, w: number): string => {
			const vw = visibleWidth(s);
			const pad = Math.max(0, Math.floor((w - vw) / 2));
			return " ".repeat(pad) + s;
		};

		if (this.phase === "booting") {
			const accent = resolveAccentRgb();
			const palette = buildPalette(accent);

			lines.push("");
			for (let i = 0; i < LOGO_LINES.length; i++) {
				const styled = gradientLine(LOGO_LINES[i]!, palette, i * ROW_PHASE_STEP);
				lines.push(center(styled, width));
			}
			lines.push("");
			lines.push("");
			for (const step of this.steps) {
				const icon = step.status === "done" ? color("\u2713", t.okFg) : step.status === "active" ? spinner : " ";
				const label =
					step.status === "done"
						? color(step.label, t.mutedFg)
						: step.status === "active"
							? step.label
							: color(step.label, t.mutedFg);
				lines.push(center(`${icon} ${label}`, width));
			}
			if (this.statusLine) {
				lines.push("");
				lines.push(center(color(this.statusLine, t.mutedFg), width));
			}
			lines.push("");
		} else {
			lines.push("");
			lines.push(center(`${spinner}  Reloading...`, width));
			if (this.statusLine) {
				lines.push(center(color(this.statusLine, t.mutedFg), width));
			}
			lines.push("");
		}

		return lines;
	}
}
