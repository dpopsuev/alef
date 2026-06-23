import { createWriteStream } from "node:fs";
import { traceEvent } from "@dpopsuev/alef-kernel/log";
import { TuiStateStore } from "@dpopsuev/alef-tui/views";
import type { SessionStore } from "@dpopsuev/alef-session";
import { ProcessTerminal, SelectList, TUI } from "@dpopsuev/alef-tui";
import type { InteractiveOptions } from "./interactive.js";
import { getUiSignalHandlers, isCompacted } from "./local-session.js";
import { ModalInputHandler } from "./modal-input.js";
import type { Session } from "./session.js";
import { bold, boldColor, color, getTheme } from "./theme.js";
import { handleColonCommand } from "./tui-commands.js";
import { createContextFactory } from "./tui-context.js";
import { dispatchTuiEvent, type TuiEvent } from "./tui-dispatch.js";
import { createHistoryPickerTheme, openHistoryPicker } from "./tui-history.js";
import { handleRawInput } from "./tui-input.js";
import { buildLayout } from "./tui-layout.js";
import { initialTuiState, syncOverlays, type TuiUi } from "./tui-state.js";
import { createSubmitHandler } from "./tui-submit.js";
import { checkForUpdate } from "./version-check.js";

export { makeMarkdownTheme, makeToolOutputMarkdownTheme } from "@dpopsuev/alef-tui/views";
export { renderDiffDisplay, renderToolLine, truncateToolOutput } from "@dpopsuev/alef-tui/views";
export type { TuiHandlerContext } from "./tui-commands.js";
export { handleColonCommand, handleCtrlC, handleSlashCommand, renderHeaderTopBorder } from "./tui-commands.js";

export async function runTuiMode(session: Session, opts: InteractiveOptions, store?: SessionStore): Promise<void> {
	const terminal = new ProcessTerminal();
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
	});
	const { output, input } = await buildLayout(tui, t, opts, tuiStore, store);
	const { writer, replyBlock, replyTW, thinkingTW, forums } = output;
	const { promptConsole, historyProvider, editor } = input;

	const tuiUi: TuiUi = { writer, replyBlock, replyTW, thinkingTW, promptConsole, tui, t, session };
	const signalHandlers = getUiSignalHandlers();
	const dispatch = (event: TuiEvent): void => {
		const prev = tuiState;
		tuiState = dispatchTuiEvent(tuiState, event, tuiUi, signalHandlers);
		syncOverlays(tui, prev.overlays, tuiState.overlays);
		tuiStore.update({
			inputTokens: tuiState.sessionInputTokens,
			outputTokens: tuiState.sessionOutputTokens,
			contextUsed: tuiState.contextFillTokens,
			thinkingLevel: session.getThinking(),
			compacted: isCompacted(),
		});
		tui.requestRender();
	};

	session.subscribe((event) => dispatch(event));

	const ctx = createContextFactory(t, writer, tui, opts, session, () => tuiState, dispatch, store, tuiStore);

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
		addToHistory: (text) => editor.addToHistory(text),
		addHistoryEntry: (text) => historyProvider.addEntry(text),
		clearEditor: () => editor.setText(""),
		dispatch,
		ctx,
		onThinkingStop: () => {
			if (promptConsole.isThinking) promptConsole.stopThinking();
		},
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
		.catch(() => {});

	await new Promise<void>((resolve) => {
		tui.onStop = () => {
			traceEvent("tui:stop:resolve");
			resolve();
		};
	});
	if (promptConsole.isThinking) promptConsole.stopThinking();
	traceEvent("tui:stopped");
}
