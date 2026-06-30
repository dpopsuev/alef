/** Color and style primitives available to adapter UI renderers. */
export interface AdapterTheme {
	fg(color: "accent" | "success" | "error" | "warning" | "muted" | "dim", text: string): string;
	bold(text: string): string;
	dim(text: string): string;
}

/** Mutable TUI surface slots that signal handlers can write into. */
export interface UiSignalSurface {
	setIntent(text: string): void;
	setStatus(text: string): void;
	setWidgetAbove(text: string): void;
}

/** Callback that updates TUI surface slots in response to a bus event payload. */
export type UiSignalHandler = (payload: Record<string, unknown>, ui: UiSignalSurface) => void;

/** Adapter-provided renderers for tool calls, results, overlays, and TUI signals. */
export interface UiContribution {
	renderCall?(toolName: string, args: Record<string, unknown>, theme: AdapterTheme): unknown;
	renderResult?(
		toolName: string,
		result: Record<string, unknown>,
		opts: { expanded: boolean; isError: boolean },
		theme: AdapterTheme,
	): unknown;
	renderOverlay?(): unknown;
	signals?: Readonly<Record<string, UiSignalHandler>>;
}

/** Adapter-provided extractor that converts motor payloads into session history entries. */
export interface HistoryContribution {
	readonly ownedTools: readonly string[];
	extractEntry(motorPayload: Record<string, unknown>): Record<string, unknown> | null;
}
