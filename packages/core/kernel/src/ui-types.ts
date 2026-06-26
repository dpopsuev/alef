export interface AdapterTheme {
	fg(color: "accent" | "success" | "error" | "warning" | "muted" | "dim", text: string): string;
	bold(text: string): string;
	dim(text: string): string;
}

export interface UiSignalSurface {
	setIntent(text: string): void;
	setStatus(text: string): void;
	setWidgetAbove(text: string): void;
}

export type UiSignalHandler = (payload: Record<string, unknown>, ui: UiSignalSurface) => void;

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

export interface HistoryContribution {
	readonly ownedTools: readonly string[];
	extractEntry(motorPayload: Record<string, unknown>): Record<string, unknown> | null;
}
