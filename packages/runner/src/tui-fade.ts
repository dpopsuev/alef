/**
 * Ghost-to-normal color fade for Text nodes.
 *
 * Used when a typewriter is interrupted (tool call fires) and remaining buffered
 * text must be revealed quickly. The effect:
 *   1. rapidFlush() on the Typewriter scans remaining chars into ghost color.
 *   2. fadeTextIn() animates the revealed text from ghost gray → normal color.
 *
 * Only runs on truecolor terminals (COLORTERM=truecolor|24bit).
 * Falls back to instant reveal on 256/16-color terminals.
 *
 * Color math:
 *   Ghost:  RGB(55, 55, 55)  — very dark gray, barely visible on dark terminal
 *   Target: RGB(140, 140, 140) — approximates chalk.dim on dark terminal
 *   Final frame snaps to the real wrapFinal(text) for correctness.
 *
 * Ease function: ease-out quadratic (fast start, slow finish) — feels natural
 * for a "brightening" transition.
 */

import { colorDepth } from "./theme.js";

const GHOST_RGB: [number, number, number] = [55, 55, 55];
const TARGET_RGB: [number, number, number] = [140, 140, 140];
const FADE_DURATION_MS = 320;
const FADE_TICK_MS = 16; // 60fps — matches TUI.MIN_RENDER_INTERVAL_MS

/** ANSI 24-bit italic + RGB foreground, reset at end. */
function ansiItalicRgb(text: string, r: number, g: number, b: number): string {
	return `\x1b[3m\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

/** Ease-out quadratic: fast start, decelerates toward 1. */
function easeOutQuad(t: number): number {
	return 1 - (1 - t) * (1 - t);
}

/** Integer lerp between two values. */
function lerpInt(a: number, b: number, t: number): number {
	return Math.round(a + (b - a) * t);
}

export interface FadeTextSink {
	setText(text: string): void;
}

/**
 * Animate text in a node from ghost gray to a normal appearance.
 *
 * @param node      Target node whose setText() accepts raw ANSI strings.
 * @param text      The full text to display (already fully revealed by rapidFlush).
 * @param wrapFinal Function that wraps text in its final ANSI style (e.g. italic+dim).
 *                  Called on the last frame so the node ends in the correct style.
 * @param onRender  Callback to trigger a TUI render each frame.
 */
export function fadeTextIn(
	node: FadeTextSink,
	text: string,
	wrapFinal: (t: string) => string,
	onRender: () => void,
): void {
	if (!text) return;

	// Only animate on truecolor terminals. On 256/16-color, snap to final.
	if (colorDepth() !== "truecolor") {
		node.setText(wrapFinal(text));
		onRender();
		return;
	}

	const frames = Math.ceil(FADE_DURATION_MS / FADE_TICK_MS);
	let frame = 0;

	// Start with ghost color (rapidFlush already set this, but set it explicitly
	// so the first fade frame is correct even if rapidFlush was skipped).
	node.setText(ansiItalicRgb(text, ...GHOST_RGB));
	onRender();

	const tick = (): void => {
		frame++;
		if (frame >= frames) {
			// Final frame: snap to the real ANSI style for correctness.
			node.setText(wrapFinal(text));
			onRender();
			return;
		}
		const t = easeOutQuad(frame / frames);
		const r = lerpInt(GHOST_RGB[0], TARGET_RGB[0], t);
		const g = lerpInt(GHOST_RGB[1], TARGET_RGB[1], t);
		const b = lerpInt(GHOST_RGB[2], TARGET_RGB[2], t);
		node.setText(ansiItalicRgb(text, r, g, b));
		onRender();
		setTimeout(tick, FADE_TICK_MS);
	};

	setTimeout(tick, FADE_TICK_MS);
}

/**
 * Ghost ANSI style for use during rapidFlush.
 * Wrap text in this so newly revealed chars appear in ghost color.
 */
export function ghostWrap(text: string): string {
	return ansiItalicRgb(text, ...GHOST_RGB);
}
