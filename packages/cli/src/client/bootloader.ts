/**
 * Bootloader overlay -- shown during startup and hot-reload transitions.
 *
 * Renders the Hebrew Alef letter (3x scale from 5x5 atomic grid + drop shadow)
 * with progress steps during BOOTING, and a compact spinner during RELOADING.
 */

import type { Component } from "@dpopsuev/alef-tui";
import { visibleWidth } from "@dpopsuev/alef-tui";
import { color, getTheme } from "./theme.js";

/* Foreground layer (accent color). */
const ALEF_FG = [
	"\u2588\u2588\u2588      \u2588\u2588\u2588\u2588\u2588\u2588 ",
	"\u2580\u2580\u2580\u2584\u2584\u2584   \u2580\u2580\u2580\u2588\u2588\u2588 ",
	"   \u2588\u2588\u2588      \u2588\u2588\u2588 ",
	"\u2588\u2588\u2588   \u2588\u2588\u2588   \u2588\u2588\u2588 ",
	"\u2588\u2588\u2588   \u2580\u2580\u2580\u2584\u2584\u2584\u2580\u2580\u2580 ",
	"\u2588\u2588\u2588      \u2588\u2588\u2588    ",
	"\u2588\u2588\u2588\u2588\u2588\u2588      \u2588\u2588\u2588 ",
	"\u2580\u2580\u2580\u2580\u2580\u2580      \u2580\u2580\u2580 ",
];

/* Shadow layer (dim color, offset 1 right + 1 down). */
const ALEF_SD = [
	"   \u2584           \u2584",
	"   \u2584      \u2580\u2580   \u2588",
	"      \u2588        \u2588",
	"   \u2584   \u2588  \u2584    \u2588",
	"   \u2588   \u2580\u2580\u2584   \u2580\u2580\u2588",
	"   \u2588        \u2588   ",
	"      \u2584   \u2580\u2580   \u2584",
	" \u2580\u2580\u2580\u2580\u2580\u2588      \u2580\u2580\u2588",
];

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
			lines.push("");
			for (let i = 0; i < ALEF_FG.length; i++) {
				const fg = ALEF_FG[i]!;
				const sd = ALEF_SD[i] ?? "";
				let combined = "";
				const len = Math.max(fg.length, sd.length);
				for (let j = 0; j < len; j++) {
					const fc = j < fg.length ? fg[j]! : " ";
					const sc = j < sd.length ? sd[j]! : " ";
					if (fc !== " ") {
						combined += color(fc, t.accentFg);
					} else if (sc !== " ") {
						combined += color(sc, t.mutedFg);
					} else {
						combined += " ";
					}
				}
				lines.push(center(combined, width));
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
