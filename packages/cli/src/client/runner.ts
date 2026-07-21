const MAX_LABEL_LENGTH = 60;

import { traceEvent } from "@dpopsuev/alef-kernel/log";
import type { Session } from "@dpopsuev/alef-session/contracts";
import type { SessionStore } from "@dpopsuev/alef-session/storage";
import { type Editor, matchesKey, type SelectItem, type SelectList, type TUI } from "@dpopsuev/alef-tui";
import type { ChatLog } from "@dpopsuev/alef-tui/views";
import { getRebootPort, getRestartStrategy, type RebootPort, type RestartStrategy } from "../boot/reboot-port.js";
import type { InteractiveOptions, RestartExecutor } from "./boot-types.js";
import type { TuiHandlerContext } from "./commands/commands.js";
import type { TuiEvent } from "./events.js";
import { handleCtrlC } from "./handlers.js";
import type { OverlayDescriptor, TuiState } from "./state.js";
import { type boldColor, type color, selectListThemeFromTokens, type ThemeTokens } from "./theme.js";

export {
	makeMarkdownTheme,
	makeToolOutputMarkdownTheme,
	renderDiffDisplay,
	renderToolLine,
	truncateToolOutput,
} from "@dpopsuev/alef-tui/views";
export type { TuiHandlerContext } from "./handlers.js";
export { handleColonCommand, handleCtrlC, renderHeaderTopBorder } from "./handlers.js";

/** A renderable entry in the discussion timeline (message or tool call). */
export interface DiscussionTimelineEntry {
	timestamp: number;
	render(): void;
}

/**
 *
 */
export interface DiscussionTimelineMessage {
	author: string;
	role: "user" | "assistant" | "other";
	text: string;
	timestamp: number;
}

/**
 *
 */
export interface RuntimeToolHistoryEntry {
	name: string;
	keyArg: string;
	timestamp: number;
}

/**
 *
 */
export type DiscussionTimelineRenderEntry =
	| { kind: "message"; message: DiscussionTimelineMessage }
	| { kind: "tool"; tool: RuntimeToolHistoryEntry };

/**
 *
 */
export function toolSummary(payload: Record<string, unknown>): string {
	if (typeof payload.path === "string" && payload.path) return payload.path;
	for (const value of Object.values(payload)) {
		if (typeof value === "string" && value) return value;
	}
	return "";
}

/**
 *
 */
export function buildDiscussionTimeline(
	messages: readonly DiscussionTimelineMessage[],
	tools: readonly RuntimeToolHistoryEntry[],
): DiscussionTimelineRenderEntry[] {
	return [
		...messages.map((message) => ({ kind: "message", message }) as const),
		...tools.map((tool) => ({ kind: "tool", tool }) as const),
	].toSorted((left, right) => {
		const leftTimestamp = left.kind === "message" ? left.message.timestamp : left.tool.timestamp;
		const rightTimestamp = right.kind === "message" ? right.message.timestamp : right.tool.timestamp;
		return leftTimestamp - rightTimestamp;
	});
}

/** Build a factory that produces a fresh TuiHandlerContext snapshot on each call. */
export function createContextFactory(
	t: ThemeTokens,
	writer: ChatLog,
	tui: TUI,
	opts: InteractiveOptions,
	session: Session,
	getState: () => TuiState,
	dispatch: (event: TuiEvent) => void,
	store?: SessionStore,
	editorRef?: Editor,
	rebootPort?: RebootPort,
	restartStrategy?: RestartStrategy,
	restartExecutor?: RestartExecutor,
): () => TuiHandlerContext {
	return () => {
		const state = getState();
		return {
			t,
			writer,
			tui,
			opts,
			session,
			store,
			dispatch,
			abortCurrentTurn: state.abortCurrentTurn,
			setAbortCurrentTurn: (fn: (() => void) | undefined) =>
				fn ? dispatch({ type: "abort.set", fn }) : dispatch({ type: "abort.clear" }),
			sessionTokens: {
				input: state.sessionInputTokens,
				output: state.sessionOutputTokens,
				total: state.sessionTokensTotal,
				costUsd: state.sessionCostUsd,
				contextFill: state.contextFillTokens,
				contextWindow: session.state.contextWindow || 0,
			},
			taskLedger: [...state.taskLedger.values()],
			editor: editorRef,
			rebootPort: rebootPort ?? getRebootPort(),
			restartStrategy: restartStrategy ?? getRestartStrategy(),
			restartExecutor,
		};
	};
}

/** Route raw terminal input to overlays, inspector, or global shortcuts before the editor sees it. */
export function handleRawInput(
	data: string,
	tuiState: TuiState,
	dispatch: (event: TuiEvent) => void,
	ctx: () => TuiHandlerContext,
	historyPickerToggle: () => boolean,
): boolean {
	if (matchesKey(data, "ctrl+r")) {
		const picker = tuiState.overlays.find((o) => o.id === "history-picker");
		if (picker) picker.handleInput?.(data);
		else historyPickerToggle();
		return true;
	}

	const overlay = tuiState.overlays.find((o) => o.handleInput);
	if (overlay?.handleInput) {
		overlay.handleInput(data);
		return true;
	}

	if (matchesKey(data, "ctrl+c")) {
		traceEvent("raw:ctrl+c");
		if (tuiState.abortCurrentTurn) {
			dispatch({ type: "turn.interrupt" });
			return true;
		}
		handleCtrlC(ctx());
		return true;
	}

	if (matchesKey(data, "ctrl+t")) {
		dispatch({ type: "thinking.toggle" });
		return true;
	}

	if (matchesKey(data, "tab") && tuiState.activeCalls.size > 0) {
		dispatch({ type: "inspector.cycle" });
		return true;
	}

	if (matchesKey(data, "escape") && tuiState.focusedCallId) {
		dispatch({ type: "inspector.close" });
		return true;
	}

	if (tuiState.focusedCallId) {
		if (matchesKey(data, "ctrl+x")) {
			dispatch({ type: "inspector.cancel" });
			return true;
		}
		if (matchesKey(data, "k") || matchesKey(data, "up")) {
			dispatch({ type: "inspector.scroll", direction: 1 });
			return true;
		}
		if (matchesKey(data, "j") || matchesKey(data, "down")) {
			dispatch({ type: "inspector.scroll", direction: -1 });
			return true;
		}
	}

	return false;
}

/**
 * Create an overlay descriptor for a component.
 */
export function createOverlay(
	id: string,
	component: OverlayDescriptor["component"],
	handleInput?: (data: string) => void,
): OverlayDescriptor {
	return { id, component, handleInput };
}

/** Overlay identifier for the command history picker. */
export const HISTORY_PICKER_ID = "history-picker";

/**
 * History provider interface - abstracts access to command history.
 */
export interface HistoryProvider {
	getEntries(): readonly string[];
	addEntry(text: string): void;
}

/**
 * Theme for the history picker select list.
 */
export interface HistoryPickerTheme {
	selectedPrefix: (s: string) => string;
	selectedText: (s: string) => string;
	description: (s: string) => string;
	scrollInfo: (s: string) => string;
	noMatch: (s: string) => string;
}

/**
 * Create a history picker theme from the TUI theme.
 */
export function createHistoryPickerTheme(
	t: ThemeTokens,
	_colorFn: typeof color,
	_boldColorFn: typeof boldColor,
): HistoryPickerTheme {
	return selectListThemeFromTokens(t, "accent-bold-color");
}

/**
 * Create a history picker overlay.
 */
export function createHistoryPicker(
	historyProvider: HistoryProvider,
	theme: HistoryPickerTheme,
	onSelect: (text: string) => void,
	onClose: () => void,
	SelectListConstructor: new (items: SelectItem[], maxVisible: number, theme: HistoryPickerTheme) => SelectList,
): OverlayDescriptor | null {
	const entries = [...historyProvider.getEntries()];
	if (entries.length === 0) return null;

	const items: SelectItem[] = entries.map((e) => ({
		value: e,
		label: e.length > MAX_LABEL_LENGTH ? `${e.slice(0, MAX_LABEL_LENGTH)}…` : e,
	}));

	const list = new SelectListConstructor(items, 6, theme);
	list.onSelect = (item: SelectItem) => {
		onSelect(item.value);
		onClose();
	};
	list.onCancel = () => onClose();

	return {
		id: HISTORY_PICKER_ID,
		component: list,
		handleInput: (d) => list.handleInput(d),
	};
}

/**
 * Open the history picker.
 */
export function openHistoryPicker(
	historyProvider: HistoryProvider,
	theme: HistoryPickerTheme,
	onSelect: (text: string) => void,
	dispatch: (event: TuiEvent) => void,
	SelectListConstructor: new (items: SelectItem[], maxVisible: number, theme: HistoryPickerTheme) => SelectList,
): boolean {
	const closeHistoryPicker = () => dispatch({ type: "overlay.hide", id: HISTORY_PICKER_ID });
	const descriptor = createHistoryPicker(historyProvider, theme, onSelect, closeHistoryPicker, SelectListConstructor);
	if (!descriptor) return false;
	dispatch({ type: "overlay.show", descriptor });
	return true;
}
