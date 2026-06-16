import { createWriteStream } from "node:fs";
import type { ISessionStore } from "@dpopsuev/alef-session";
import { matchesKey, ProcessTerminal, type SelectItem, SelectList, TUI } from "@dpopsuev/alef-tui";
import { trace } from "./debug-trace.js";
import { parseAtAddress } from "./identity/routes.js";
import type { InteractiveOptions } from "./interactive.js";
import { ModalInputHandler } from "./modal-input.js";
import type { Session } from "./session.js";
import { bold, boldColor, color, getTheme } from "./theme.js";
import { handleColonCommand, handleCtrlC, handleSlashCommand } from "./tui-commands.js";
import { buildLayout } from "./tui-layout.js";
import { type TuiEvent, tuiReducer } from "./tui-reducer.js";
import { initialTuiState, syncOverlays, type TuiUi } from "./tui-state.js";
import { checkForUpdate } from "./version-check.js";

export { makeMarkdownTheme, makeToolOutputMarkdownTheme } from "./tui/markdown-themes.js";
export { renderDiffDisplay, renderToolLine, truncateToolOutput } from "./tui/tool-view.js";
export type { TuiHandlerContext } from "./tui-commands.js";
export { handleColonCommand, handleCtrlC, handleSlashCommand, renderHeaderTopBorder } from "./tui-commands.js";

const HISTORY_PICKER_ID = "history-picker";

export async function runTuiMode(session: Session, opts: InteractiveOptions, store?: ISessionStore): Promise<void> {
	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal);
	const t = getTheme();

	if (process.env.ALEF_DEBUG === "1") {
		const frameStream = createWriteStream("/tmp/alef-frames.jsonl", { flags: "a" });
		tui.onRender = (frame: string, width: number) => {
			frameStream.write(`${JSON.stringify({ frame, width, ...tui.renderMeta })}\n`);
		};
	}

	let tuiState = initialTuiState();
	const layout = await buildLayout(tui, t, opts, () => tuiState.sessionTokensTotal, store);
	const { writer, replyBlock, replyTW, thinkingTW, promptConsole, historyProvider } = layout;
	const { editor } = promptConsole;

	const tuiUi: TuiUi = { writer, replyBlock, replyTW, thinkingTW, promptConsole, tui, t, session };
	const dispatch = (event: TuiEvent): void => {
		const prev = tuiState;
		tuiState = tuiReducer(tuiState, event, tuiUi);
		syncOverlays(tui, prev.overlays, tuiState.overlays);
		tui.requestRender();
	};

	session.subscribe((event) => dispatch(event));

	const ctx = () => ({
		t,
		writer,
		tui,
		opts,
		session,
		abortCurrentTurn: tuiState.abortCurrentTurn,
		setAbortCurrentTurn: (fn: (() => void) | undefined) =>
			fn ? dispatch({ type: "abort.set", fn }) : dispatch({ type: "abort.clear" }),
	});

	const closeHistoryPicker = () => dispatch({ type: "overlay.hide", id: HISTORY_PICKER_ID });
	const openHistoryPicker = (): boolean => {
		const entries = historyProvider.getEntries();
		if (entries.length === 0) return false;
		const pickTheme = {
			selectedPrefix: (s: string) => color(s, t.accentFg),
			selectedText: (s: string) => boldColor(s, t.accentFg),
			description: (s: string) => color(s, t.mutedFg),
			scrollInfo: (s: string) => color(s, t.mutedFg),
			noMatch: (s: string) => color(s, t.mutedFg),
		};
		const items: SelectItem[] = entries.map((e) => ({ value: e, label: e.length > 60 ? `${e.slice(0, 60)}…` : e }));
		const list = new SelectList(items, 6, pickTheme);
		list.onSelect = (item: SelectItem) => {
			editor.setText(item.value);
			closeHistoryPicker();
		};
		list.onCancel = () => closeHistoryPicker();
		dispatch({
			type: "overlay.show",
			descriptor: { id: HISTORY_PICKER_ID, component: list, handleInput: (d) => list.handleInput(d) },
		});
		return true;
	};

	tui.onRawInput = (data) => {
		if (data === "\x12") {
			const picker = tuiState.overlays.find((o) => o.id === HISTORY_PICKER_ID);
			if (picker) picker.handleInput?.("\x1b");
			else openHistoryPicker();
			return true;
		}
		const overlay = tuiState.overlays.find((o) => o.handleInput);
		if (overlay?.handleInput) {
			overlay.handleInput(data);
			tui.requestRender();
			return true;
		}
		if (matchesKey(data, "ctrl+c")) {
			trace("raw:ctrl+c");
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
	};

	const actorRoutes = opts.actorRoutes;

	// eslint-disable-next-line @typescript-eslint/no-misused-promises
	editor.onSubmit = async (rawText: string) => {
		const text = rawText.trim();
		if (!text) return;
		if (text.startsWith("/")) {
			handleSlashCommand(text, ctx());
			return;
		}

		// @-routing: "@crimson do something" → route "do something" to @crimson
		if (text.startsWith("@") && actorRoutes) {
			const parsed = parseAtAddress(text);
			if (parsed) {
				const route = actorRoutes.resolve(parsed.address);
				if (actorRoutes.isHumanAddress(parsed.address)) {
					writer.addNotice("You can't message yourself.");
					return;
				}
				if (!route) {
					const known = actorRoutes
						.addresses()
						.map((a) => `@${a}`)
						.join(", ");
					writer.addNotice(`Unknown actor: @${parsed.address}. Known: ${known || "(none)"}`);
					return;
				}
				editor.addToHistory(text);
				if (tuiState.abortCurrentTurn) tuiState.abortCurrentTurn();
				editor.setText("");
				historyProvider.addEntry(text);
				writer.addUserMessage(text);
				dispatch({ type: "turn.start", timestamp: Date.now() });
				let aborted = false;
				const controller = new AbortController();
				session.setTurnController(controller);
				dispatch({
					type: "abort.set",
					fn: () => {
						aborted = true;
						controller.abort();
					},
				});
				try {
					await route(parsed.message, 300_000);
					if (!aborted) dispatch({ type: "turn.complete", tokenFooter: writer.addTokenFooter() });
				} catch (e) {
					dispatch({ type: "turn.error", error: e, aborted });
				} finally {
					dispatch({ type: "abort.clear" });
					session.setTurnController(undefined);
					if (promptConsole.isThinking) promptConsole.stopThinking();
				}
				return;
			}
		}

		editor.addToHistory(text);
		if (tuiState.abortCurrentTurn) tuiState.abortCurrentTurn();
		editor.setText("");
		historyProvider.addEntry(text);
		writer.addUserMessage(text);
		dispatch({ type: "turn.start", timestamp: Date.now() });
		let aborted = false;
		const controller = new AbortController();
		session.setTurnController(controller);
		dispatch({
			type: "abort.set",
			fn: () => {
				aborted = true;
				controller.abort();
			},
		});
		try {
			if (session.send) await session.send(text, 300_000);
			if (!aborted) dispatch({ type: "turn.complete", tokenFooter: writer.addTokenFooter() });
		} catch (e) {
			dispatch({ type: "turn.error", error: e, aborted });
		} finally {
			dispatch({ type: "abort.clear" });
			session.setTurnController(undefined);
			if (promptConsole.isThinking) promptConsole.stopThinking();
		}
	};

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
