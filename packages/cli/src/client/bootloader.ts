/**
 * Bootloader overlay -- shown during startup and hot-reload transitions.
 *
 * Renders a centered ASCII splash with progress steps during BOOTING,
 * and a compact spinner during RELOADING.
 */

import type { Component } from "@dpopsuev/alef-tui";
import { bold, color, getTheme } from "./theme.js";

const SPLASH = [
	"        _       __",
	"  __ _ | | ___ / _|",
	" / _` || |/ _ \\ |_ ",
	"| (_| || |  __/  _|",
	" \\__,_||_|\\___|_|  ",
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
 * Call update() to advance steps, then render() reflects the change.
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
			const pad = Math.max(0, Math.floor((w - s.length) / 2));
			return " ".repeat(pad) + s;
		};

		if (this.phase === "booting") {
			lines.push("");
			for (const line of SPLASH) {
				lines.push(center(bold(color(line, t.primaryFg)), width));
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
