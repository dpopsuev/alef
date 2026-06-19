import { createWriteStream } from "node:fs";
import type { ISessionStore } from "@dpopsuev/alef-session";
import { ProcessTerminal, SelectList, TUI } from "@dpopsuev/alef-tui";
import { trace } from "./debug-trace.js";
import type { InteractiveOptions } from "./interactive.js";
import { ModalInputHandler } from "./modal-input.js";
import type { Session } from "./session.js";
import { bold, boldColor, color, getTheme } from "./theme.js";
import { handleColonCommand } from "./tui-commands.js";
import { createContextFactory } from "./tui-context.js";
import { createHistoryPickerTheme, openHistoryPicker } from "./tui-history.js";
import { handleRawInput } from "./tui-input.js";
import { buildLayout } from "./tui-layout.js";
import { type TuiEvent, tuiReducer } from "./tui-reducer.js";
import { initialTuiState, syncOverlays, type TuiUi } from "./tui-state.js";
import { createSubmitHandler } from "./tui-submit.js";
import { checkForUpdate } from "./version-check.js";

export { makeMarkdownTheme, makeToolOutputMarkdownTheme } from "./tui/markdown-themes.js";
export { renderDiffDisplay, renderToolLine, truncateToolOutput } from "./tui/tool-view.js";
export type { TuiHandlerContext } from "./tui-commands.js";
export { handleColonCommand, handleCtrlC, handleSlashCommand, renderHeaderTopBorder } from "./tui-commands.js";

export async function runTuiMode(session: Session, opts: InteractiveOptions, store?: ISessionStore): Promise<void> {
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
	const layout = await buildLayout(tui, t, opts, () => tuiState.sessionTokensTotal, store);
	const { writer, replyBlock, replyTW, thinkingTW, promptConsole, historyProvider, channels } = layout;
	const { editor } = promptConsole;

	const tuiUi: TuiUi = { writer, replyBlock, replyTW, thinkingTW, promptConsole, tui, t, session };
	const dispatch = (event: TuiEvent): void => {
		const prev = tuiState;
		tuiState = tuiReducer(tuiState, event, tuiUi);
		syncOverlays(tui, prev.overlays, tuiState.overlays);
		tui.requestRender();
	};

	session.subscribe((event) => dispatch(event));

	const ctx = createContextFactory(t, writer, tui, opts, session, () => tuiState, dispatch);

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
		channels,
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
					promptConsole.setStatus(mode === "normal" ? color(bold("NORMAL"), t.mutedFg) : "");
				tui.requestRender();
			},
			(hint) => {
				if (!promptConsole.isThinking)
					promptConsole.setStatus(hint ? color(hint, t.mutedFg) : color(bold("NORMAL"), t.mutedFg));
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
	trace("tui:start");
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
			trace("tui:stop:resolve");
			resolve();
		};
	});
	if (promptConsole.isThinking) promptConsole.stopThinking();
	trace("tui:stopped");
}
