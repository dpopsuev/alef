/**
 * Component abstraction — extracted from tui.ts to break the
 * tui/src <-> tui/src/components cycle (DIP: abstractions must not
 * depend on concretions).
 *
 * Both tui.ts and components/ import from here. Neither imports the other.
 */

/** All TUI components must implement this interface. */
export interface Component {
	/**
	 * Render the component to lines for the given viewport width.
	 * @param width - Current viewport width
	 * @returns Array of strings, each representing a line
	 */
	render(width: number): string[];

	/** Optional handler for keyboard input when component has focus. */
	handleInput?(data: string): void;

	/**
	 * If true, component receives key release events (Kitty protocol).
	 * Default is false — release events are filtered out.
	 */
	wantsKeyRelease?: boolean;

	/**
	 * Invalidate any cached rendering state.
	 * Called when theme changes or when component needs to re-render from scratch.
	 */
	invalidate(): void;
}

/**
 * Interface for components that can receive focus and display a hardware cursor.
 * When focused, the component emits CURSOR_MARKER at the cursor position.
 * TUI finds this marker and positions the hardware cursor there.
 */
export interface Focusable {
	/** Set by TUI when focus changes. Component should emit CURSOR_MARKER when true. */
	focused: boolean;
}

/** Type guard to check if a component implements Focusable. */
export function isFocusable(component: Component | null): component is Component & Focusable {
	return component !== null && "focused" in component;
}

/**
 * Cursor position marker — APC (Application Program Command) sequence.
 * Zero-width; terminals ignore it. Components emit this at the cursor
 * position when focused. TUI strips the marker and positions the hardware cursor.
 */
export const CURSOR_MARKER = "\x1b_pi:c\x07";

/**
 * Render decision metadata — populated after every doRender() call.
 *
 * renderPath values:
 *   first         — initial blank-screen write
 *   width-change  — terminal resized horizontally; full clear redraw
 *   height-change — terminal resized vertically; full clear redraw
 *   dock-reflow — dock band height changed; full viewport rewrite (no scrollback clear)
 *   clear-shrink  — content shrank below max rendered; full clear redraw
 *   scrollback    — firstChanged < prevViewportTop; scrollback risk
 *   deleted       — lines deleted and viewport moved up; full clear redraw
 *   diff          — differential update; cursor moved to changed line
 *   append        — lines appended at end; no upward cursor movement
 *   no-change     — virtual frame identical; only cursor repositioned
 *   none          — no render attempted
 */
export interface RenderMeta {
	renderPath:
		| "first"
		| "width-change"
		| "height-change"
		| "dock-reflow"
		| "clear-shrink"
		| "scrollback"
		| "deleted"
		| "diff"
		| "append"
		| "no-change"
		| "dock-full"
		| "none";
	/** Index of the first changed virtual line (-1 if none). */
	firstChanged: number;
	/** First virtual line index within the visible viewport. */
	prevViewportTop: number;
	/** Total virtual lines rendered. */
	totalLines: number;
	/** Terminal height in rows. */
	height: number;
	/** Date.now() when this render completed. */
	ts: number;
}

/**
 * Minimal TUI surface that components needing render scheduling depend on.
 * Using this interface instead of the concrete TUI class keeps components
 * decoupled from the full TUI implementation.
 */
export interface TuiHandle {
	requestRender(): void;
	readonly terminal: { readonly rows: number };
}
