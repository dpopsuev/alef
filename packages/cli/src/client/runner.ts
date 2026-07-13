const MAX_LABEL_LENGTH = 60;

import { createWriteStream } from "node:fs";
import { traceEvent } from "@dpopsuev/alef-kernel/log";
import type { Session } from "@dpopsuev/alef-session/contracts";
import type { SessionStore } from "@dpopsuev/alef-session/storage";
import { ProcessTerminal, type SelectItem, SelectList, setTraceSink, type Terminal, TUI } from "@dpopsuev/alef-tui";
import { type ChatLog, TuiStateStore } from "@dpopsuev/alef-tui/views";
import type { InteractiveOptions } from "../boot/interactive.js";
import { getUiSignalHandlers, isCompacted } from "../boot/session.js";
import { checkForUpdate } from "../boot/version-check.js";
import type { TuiHandlerContext } from "./commands/commands.js";
import { dispatchTuiEvent, type TuiEvent } from "./events.js";
import { handleColonCommand, handleCtrlC } from "./handlers.js";
import { buildLayout } from "./layout.js";
import { ModalInputHandler } from "./modal.js";
import { initialTuiState, type OverlayDescriptor, syncOverlays, type TuiState, type TuiUi } from "./state.js";
import { createSubmitHandler } from "./submit.js";
import { bold, boldColor, color, getTheme, type ThemeTokens } from "./theme.js";

export {
	makeMarkdownTheme,
	makeToolOutputMarkdownTheme,
	renderDiffDisplay,
	renderToolLine,
	truncateToolOutput,
} from "@dpopsuev/alef-tui/views";
export type { TuiHandlerContext } from "./handlers.js";
export { handleColonCommand, handleCtrlC, handleSlashCommand, renderHeaderTopBorder } from "./handlers.js";

/** Boot the interactive TUI loop — wires layout, event dispatch, modal input, and session I/O. */
export async function runTuiMode(
	session: Session,
	opts: InteractiveOptions & { terminal?: Terminal },
	store?: SessionStore,
): Promise<void> {
	setTraceSink(traceEvent);
	const terminal = opts.terminal ?? new ProcessTerminal();
	const tui = new TUI(terminal);
	const t = getTheme();

	if (process.env.ALEF_DEBUG === "1") {
		const frameStream = createWriteStream("/tmp/alef-frames.jsonl", { flags: "w" });
		let frameBytes = 0;
		const MAX_FRAME_BYTES = 50 * 1024 * 1024;
		tui.onRender = (frame: string, width: number) => {
			if (frameBytes > MAX_FRAME_BYTES) return;
			const line = `${JSON.stringify({ frame, width, ...tui.renderMeta })}\n`;
			frameBytes += line.length;
			frameStream.write(line);
		};
	}

	let tuiState = initialTuiState();
	const tuiStore = new TuiStateStore({
		modelId: opts.modelId,
		thinkingLevel: session.getThinking(),
		inputTokens: 0,
		outputTokens: 0,
		contextWindow: session.state.contextWindow,
		contextUsed: 0,
		compacted: false,
		costUsd: 0,
	});
	const { output, input } = await buildLayout(tui, t, opts, tuiStore, store);
	const { writer, replyBlock, replyTW, thinkingTW, forums } = output;
	const { promptConsole, historyProvider, editor } = input;

	const tuiUi: TuiUi = { writer, replyBlock, replyTW, thinkingTW, promptConsole, tui, t, session };
	const signalHandlers = getUiSignalHandlers();
	let liveContextWindow = session.state.contextWindow;
	const dispatch = (event: TuiEvent): void => {
		if (event.type === "state-changed") liveContextWindow = event.contextWindow;
		const prev = tuiState;
		tuiState = dispatchTuiEvent(tuiState, event, tuiUi, signalHandlers);
		syncOverlays(tui, prev.overlays, tuiState.overlays);
		tuiStore.update({
			modelId: session.getModel(),
			inputTokens: tuiState.sessionInputTokens,
			outputTokens: tuiState.sessionOutputTokens,
			contextUsed: tuiState.contextFillTokens,
			contextWindow: liveContextWindow,
			thinkingLevel: session.getThinking(),
			compacted: isCompacted(),
			costUsd: tuiState.sessionCostUsd,
		});
		tui.requestRender();
	};

	session.subscribe((event) => {
		traceEvent("tui:observer", { eventType: event.type });
		dispatch(event);
	});

	const ctx = createContextFactory(t, writer, tui, opts, session, () => tuiState, dispatch, store);

	const historyPickerTheme = createHistoryPickerTheme(t, color, boldColor);
	const historyPickerToggle = (): boolean =>
		openHistoryPicker(historyProvider, historyPickerTheme, (text) => editor.setText(text), dispatch, SelectList);

	tui.onRawInput = (data) => {
		const handled = handleRawInput(data, tuiState, dispatch, ctx, historyPickerToggle);
		if (handled) {
			tui.requestRender();
		}
		return handled;
	};

	const actorRoutes = opts.actorRoutes;

	// eslint-disable-next-line @typescript-eslint/no-misused-promises
	editor.onSubmit = createSubmitHandler({
		actorRoutes,
		session,
		writer,
		forums,
		addToHistory: (text) => {
			editor.addToHistory(text);
			editor.clearAttachments();
		},
		addHistoryEntry: (text) => historyProvider.addEntry(text),
		clearEditor: () => editor.setText(""),
		dispatch,
		ctx,
		onThinkingStop: () => {
			if (promptConsole.isThinking) promptConsole.stopThinking();
		},
		isTurnActive: () => promptConsole.isThinking,
	});

	tui.addInputListener(
		new ModalInputHandler(
			editor,
			(mode) => {
				if (!promptConsole.isThinking)
					promptConsole.setStatus(
						mode === "normal" ? color(bold("NORMAL"), t.mutedFg) : color(bold("INSERT"), t.accentFg),
					);
				tui.requestRender();
			},
			(hint) => {
				if (!promptConsole.isThinking) promptConsole.setHint(hint ? color(hint, t.mutedFg) : "");
				tui.requestRender();
			},
			(colonCmd) => {
				handleColonCommand(colonCmd, ctx());
			},
		).handle,
	);

	tui.start();
	tui.setFocus(editor);
	promptConsole.setStatus(color(bold("INSERT"), t.accentFg));
	tui.requestRender();
	traceEvent("tui:start");
	if (process.env.ALEF_DEBUG === "1") process.stdout.write("[ALEF_READY]\n");
	checkForUpdate()
		.then((n) => {
			if (n) {
				writer.addNotice(n);
				tui.requestRender();
			}
		})
		.catch(() => {
			// Update check is best-effort — network failures are expected.
		});

	await new Promise<void>((resolve) => {
		tui.onStop = () => {
			traceEvent("tui:stop:resolve");
			resolve();
		};
	});
	if (promptConsole.isThinking) promptConsole.stopThinking();
	traceEvent("tui:stopped");
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
): () => TuiHandlerContext {
	return () => ({
		t,
		writer,
		tui,
		opts,
		session,
		store,
		dispatch,
		abortCurrentTurn: getState().abortCurrentTurn,
		setAbortCurrentTurn: (fn: (() => void) | undefined) =>
			fn ? dispatch({ type: "abort.set", fn }) : dispatch({ type: "abort.clear" }),
	});
}

const KEY = {
	CTRL_C: "\x03",
	CTRL_R: "\x12",
	CTRL_T: "\x14",
	TAB: "\t",
	ESC: "\x1b",
	SHIFT_TAB: "\x1b[Z",
	UP: "\x1b[A",
	DOWN: "\x1b[B",
} as const;

const KEY_MAP: Record<string, string> = {
	"ctrl+c": KEY.CTRL_C,
	"ctrl+r": KEY.CTRL_R,
	"ctrl+t": KEY.CTRL_T,
	tab: KEY.TAB,
	escape: KEY.ESC,
	"shift+tab": KEY.SHIFT_TAB,
	up: KEY.UP,
	down: KEY.DOWN,
};

/** Test whether a raw terminal data string matches a named key combo. */
function matchesKey(data: string, combo: string): boolean {
	return data === (KEY_MAP[combo] ?? combo);
}

/** Route raw terminal input to overlays, inspector, or global shortcuts before the editor sees it. */
export function handleRawInput(
	data: string,
	tuiState: TuiState,
	dispatch: (event: TuiEvent) => void,
	ctx: () => TuiHandlerContext,
	historyPickerToggle: () => boolean,
): boolean {
	// Ctrl+R: Toggle history picker
	if (matchesKey(data, "ctrl+r")) {
		const picker = tuiState.overlays.find((o) => o.id === "history-picker");
		if (picker) picker.handleInput?.(data);
		else historyPickerToggle();
		return true;
	}

	// Check if any overlay wants to handle the input
	const overlay = tuiState.overlays.find((o) => o.handleInput);
	if (overlay?.handleInput) {
		overlay.handleInput(data);
		return true;
	}

	// Ctrl+C: Interrupt or quit
	if (matchesKey(data, "ctrl+c")) {
		traceEvent("raw:ctrl+c");
		handleCtrlC(ctx());
		return true;
	}

	// Ctrl+T: Toggle thinking visibility
	if (matchesKey(data, "ctrl+t")) {
		dispatch({ type: "thinking.toggle" });
		return true;
	}

	// Tab: Cycle through tool inspector when tools are active
	if (matchesKey(data, "tab") && tuiState.activeCalls.size > 0) {
		dispatch({ type: "inspector.cycle" });
		return true;
	}

	// Escape: Close tool inspector
	if (matchesKey(data, "escape") && tuiState.focusedCallId) {
		dispatch({ type: "inspector.close" });
		return true;
	}

	// Tool inspector navigation and control
	if (tuiState.focusedCallId) {
		// Ctrl+X: Cancel focused tool call
		if (matchesKey(data, "ctrl+x")) {
			dispatch({ type: "inspector.cancel" });
			return true;
		}
		// K or Up: Scroll up
		if (matchesKey(data, "k") || matchesKey(data, "up")) {
			dispatch({ type: "inspector.scroll", direction: 1 });
			return true;
		}
		// J or Down: Scroll down
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
	colorFn: typeof color,
	boldColorFn: typeof boldColor,
): HistoryPickerTheme {
	return {
		selectedPrefix: (s: string) => colorFn(s, t.accentFg),
		selectedText: (s: string) => boldColorFn(s, t.accentFg),
		description: (s: string) => colorFn(s, t.mutedFg),
		scrollInfo: (s: string) => colorFn(s, t.mutedFg),
		noMatch: (s: string) => colorFn(s, t.mutedFg),
	};
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
