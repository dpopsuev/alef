/**
 * Bootloader overlay -- shown during startup and warm reboot transitions.
 *
 * Renders a glyph from the greeter's splash pipeline with theme-aware
 * gradient coloring, plus progress steps / spinner. Falls back to the
 * hardcoded Hebrew Alef logo when no splash glyph is available.
 */

import type { Component } from "@dpopsuev/alef-tui";
import { visibleWidth } from "@dpopsuev/alef-tui";
import { renderAlefLogo } from "./alef-logo.js";
import { buildPalette, gradientLine, hexToRgb, type Rgb } from "./gradient.js";
import type { SplashResult } from "./greeter.js";
import { color, getTheme } from "./theme.js";

const PALETTE_STEPS = 24;
const MAX_DARKEN = 0.18;
const MAX_LIGHTEN = 0.18;
const ROW_PHASE_STEP = 0.12;

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

/** Resolve the accent color to RGB from the theme token. */
function resolveAccentRgb(): Rgb {
	const t = getTheme();
	const token = t.accentFg;
	if (token.truecolor) {
		return hexToRgb(token.truecolor) ?? [100, 140, 255];
	}
	return [100, 140, 255];
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
	private splash: SplashResult | null = null;

	/** Set the splash glyph result from the greeter pipeline. */
	setSplash(splash: SplashResult | null): void {
		this.splash = splash;
	}

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
			const logoLines = this.splash?.lines ?? renderAlefLogo(5, 1, 2);
			const accent = resolveAccentRgb();
			const palette = buildPalette(accent, PALETTE_STEPS, MAX_DARKEN, MAX_LIGHTEN);

			lines.push("");
			for (let i = 0; i < logoLines.length; i++) {
				const styled = gradientLine(logoLines[i]!, palette, i * ROW_PHASE_STEP);
				lines.push(center(styled, width));
			}

			if (this.splash) {
				lines.push("");
				lines.push(center(color(`${this.splash.glyph}  ${this.splash.script}`, t.mutedFg), width));
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
