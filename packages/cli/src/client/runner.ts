const MAX_LABEL_LENGTH = 60;

import { createWriteStream } from "node:fs";
import { traceEvent } from "@dpopsuev/alef-kernel/log";
import type { Session } from "@dpopsuev/alef-session/contracts";
import type { SessionStore } from "@dpopsuev/alef-session/storage";
import {
	type Editor,
	ProcessTerminal,
	type SelectItem,
	SelectList,
	setTraceSink,
	type Terminal,
	TUI,
} from "@dpopsuev/alef-tui";
import { type ChatLog, TuiStateStore, yieldToEventLoop } from "@dpopsuev/alef-tui/views";
import type { InteractiveOptions } from "../boot/interactive.js";
import { getUiSignalHandlers, isCompacted } from "../boot/session.js";
import { checkForUpdate } from "../boot/version-check.js";
import { displayActorName } from "./actor-label.js";
import type { TuiHandlerContext } from "./commands/commands.js";
import { dispatchTuiEvent, type TuiEvent } from "./events.js";
import { handleColonCommand, handleCtrlC } from "./handlers.js";
import { buildLayout } from "./layout.js";
import { ModalInputHandler } from "./modal.js";
import { initialTuiState, type OverlayDescriptor, syncOverlays, type TuiState, type TuiUi } from "./state.js";
import { createSubmitHandler } from "./submit.js";
import { bold, boldColor, color, getTheme, selectListThemeFromTokens, type ThemeTokens } from "./theme.js";

export {
	makeMarkdownTheme,
	makeToolOutputMarkdownTheme,
	renderDiffDisplay,
	renderToolLine,
	truncateToolOutput,
} from "@dpopsuev/alef-tui/views";
export type { TuiHandlerContext } from "./handlers.js";
export { handleColonCommand, handleCtrlC, renderHeaderTopBorder } from "./handlers.js";

interface DiscussionTimelineEntry {
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
function toolSummary(payload: Record<string, unknown>): string {
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
	// Boot splash overlay -- shown while layout builds and history loads
	const { Bootloader } = await import("./bootloader.js");
	const bootloader = new Bootloader();
	bootloader.setPhase("booting");
	bootloader.setSteps([
		{ label: "Loading session", status: "active" },
		{ label: "Building layout", status: "pending" },
		{ label: "Ready", status: "pending" },
	]);
	bootloader.start(() => tui.requestRender());
	const bootOverlay = tui.showOverlay(bootloader, { anchor: "center", nonCapturing: true });
	tui.requestRender(true);

	bootloader.setSteps([
		{ label: "Loading session", status: "done" },
		{ label: "Building layout", status: "active" },
		{ label: "Ready", status: "pending" },
	]);

	const { output, input, footer } = await buildLayout(tui, t, opts, tuiStore);
	const { writer, replyBlock, replyTW, thinkingTW, forums } = output;
	const { promptConsole, historyProvider, editor } = input;

	bootloader.setSteps([
		{ label: "Loading session", status: "done" },
		{ label: "Building layout", status: "done" },
		{ label: "Ready", status: "active" },
	]);
	tui.requestRender();

	// Dismiss boot splash after a brief flash so user sees it
	setTimeout(() => {
		bootloader.stop();
		bootOverlay.hide();
		tui.requestRender(true);
	}, 400);
	let discussionReloadSeq = 0;
	let historyAbort: AbortController | undefined;
	let activeDiscussionKey = opts.discussion ? `${opts.discussion.forumId}/${opts.discussion.topicId}` : "";
	const DISCUSSION_PAINT_CHUNK = 8;

	const loadDiscussion = async (topicId?: string): Promise<void> => {
		if (!session.readDiscussionTopic) return;
		historyAbort?.abort();
		const reloadSeq = ++discussionReloadSeq;
		footer.setStatus("history", "loading…");
		const messages = await session.readDiscussionTopic(topicId);
		const tools: RuntimeToolHistoryEntry[] = [];
		const activeDiscussion = session.getDiscussion?.();
		const homeDiscussion = session.getDiscussionState?.()?.home;
		if (
			store &&
			activeDiscussion &&
			homeDiscussion &&
			activeDiscussion.forumId === homeDiscussion.forumId &&
			(topicId ?? activeDiscussion.topicId) === homeDiscussion.topicId
		) {
			const events = await store.events();
			for (const event of events) {
				if (event.bus !== "command") continue;
				if (event.type === "discourse.post" || event.type.startsWith("llm.") || event.type.startsWith("context."))
					continue;
				tools.push({ name: event.type, keyArg: toolSummary(event.payload), timestamp: event.timestamp });
			}
		}
		if (reloadSeq !== discussionReloadSeq) return;
		const entries: DiscussionTimelineEntry[] = buildDiscussionTimeline(messages, tools).map((entry) =>
			entry.kind === "message"
				? {
						timestamp: entry.message.timestamp,
						render: () => {
							if (entry.message.role === "assistant") writer.addAgentReply(entry.message.text);
							else if (entry.message.role === "user") writer.addUserMessage(entry.message.text);
							else writer.addNotice(`${displayActorName(entry.message.author, "other")}: ${entry.message.text}`);
						},
					}
				: {
						timestamp: entry.tool.timestamp,
						render: () =>
							writer.addCompletedToolBlock(entry.tool.name, entry.tool.keyArg, {}, 0, true, null, null),
					},
		);
		writer.clearAll();
		tui.requestRender();
		for (let offset = 0; offset < entries.length; offset += DISCUSSION_PAINT_CHUNK) {
			if (reloadSeq !== discussionReloadSeq) return;
			const slice = entries.slice(offset, offset + DISCUSSION_PAINT_CHUNK);
			for (const entry of slice) entry.render();
			tui.requestRender();
			await yieldToEventLoop();
		}
		if (reloadSeq === discussionReloadSeq) footer.setStatus("history", undefined);
	};

	promptConsole.setTopicLabel(opts.discussion?.topicTitle ?? "");

	const tuiUi: TuiUi = { writer, replyBlock, replyTW, thinkingTW, promptConsole, tui, t, session };
	const signalHandlers = getUiSignalHandlers();
	let liveContextWindow = session.state.contextWindow;
	const dispatch = (event: TuiEvent): void => {
		if (event.type === "state-changed") liveContextWindow = event.contextWindow;
		const prev = tuiState;
		const prevContextUsed = tuiStore.get().contextUsed;
		tuiState = dispatchTuiEvent(tuiState, event, tuiUi, signalHandlers);
		syncOverlays(tui, prev.overlays, tuiState.overlays);
		if (event.type === "adapter-signal") {
			if (event.signalType === "context.compacting") {
				footer.setCompacting(event.payload.active === true);
			} else if (event.signalType === "context.compacted") {
				const before = Number(event.payload.estimatedBefore ?? prevContextUsed);
				const after = Number(event.payload.estimatedAfter ?? tuiState.contextFillTokens);
				footer.playDrain(before, after);
			}
		}
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
		if (event.type === "discussion-changed") {
			const nextKey = `${event.discussion.active.forumId}/${event.discussion.active.topicId}`;
			if (nextKey !== activeDiscussionKey) {
				activeDiscussionKey = nextKey;
				void loadDiscussion(event.discussion.active.topicId);
			}
		}
	});

	const ctx = createContextFactory(t, writer, tui, opts, session, () => tuiState, dispatch, store, editor);

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
		forums:
			session.getDiscussion && session.setDiscussion && session.listDiscussionTopics
				? {
						switchTo: (name: string) => {
							session.setDiscussion?.({ topicId: name, topicTitle: name });
						},
						list: () => session.listDiscussionTopics?.() ?? [],
						getActive: () => session.getDiscussion?.()?.topicId ?? "",
					}
				: {
						switchTo: (name: string) => forums.switchTo(name),
						list: () => forums.list(),
						getActive: () => forums.active,
					},
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
	// History/discussion paint after start so resume never blocks scroll or input.
	if (session.readDiscussionTopic) {
		void loadDiscussion();
	} else if (store) {
		historyAbort = new AbortController();
		footer.setStatus("history", "loading…");
		void output
			.loadHistory(store, tui, opts.cwd, historyAbort.signal)
			.finally(() => footer.setStatus("history", undefined));
	}
	if (process.env.ALEF_DEBUG === "1") process.stdout.write("[ALEF_READY]\n");
	checkForUpdate()
		.then((n) => {
			if (n) {
				writer.addNotice(n);
				const match = n.match(/New version (\S+)/);
				if (match?.[1]) footer.setUpdateAvailable(match[1]);
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
	editorRef?: Editor,
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
		};
	};
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
