/**
 * TUI shell -- session-independent TUI setup.
 *
 * Creates the TUI, layout, input handling, and modal handler without
 * requiring a Session. The Bootstrapper calls bootTuiShell() first,
 * then wireSession() once the agent is assembled.
 *
 * This module imports nothing from boot/ at runtime -- all supervisor
 * dependencies arrive through WireSessionDeps injection.
 */

import { createWriteStream } from "node:fs";
import { traceEvent } from "@dpopsuev/alef-kernel/log";
import { ProcessTerminal, SelectList, setTraceSink, TUI } from "@dpopsuev/alef-tui";
import { TuiStateStore, yieldToEventLoop } from "@dpopsuev/alef-tui/views";
import { displayActorName } from "./actor-label.js";
import type { InteractiveOptions, ResolvedSession, TuiShell, TuiShellContext, WireSessionDeps } from "./boot-types.js";
import { type DispatchEvent, dispatchEvent } from "./events.js";
import { handleColonCommand } from "./handlers.js";
import { buildLayout } from "./layout.js";
import { ModalInputHandler } from "./modal.js";
import {
	buildDiscussionTimeline,
	createContextFactory,
	createHistoryPickerTheme,
	type DiscussionTimelineEntry,
	handleRawInput,
	openHistoryPicker,
	type RuntimeToolHistoryEntry,
	toolSummary,
} from "./runner.js";
import { type DispatchPorts, initialDispatchState, syncOverlays } from "./state.js";
import { createSubmitHandler } from "./submit.js";
import { bold, boldColor, color, getTheme } from "./theme.js";

// ---------------------------------------------------------------------------
// bootTuiShell -- session-independent TUI setup
// ---------------------------------------------------------------------------

/**
 * Boot the TUI shell: layout, input handling, modal handler.
 * No Session required. Returns a TuiShell that wireSession() connects later.
 */
export function bootTuiShell(ctx: TuiShellContext): TuiShell {
	setTraceSink(traceEvent);
	const terminal = ctx.terminal ?? new ProcessTerminal();
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

	const tuiStore = new TuiStateStore({
		modelId: "",
		thinkingLevel: "",
		inputTokens: 0,
		outputTokens: 0,
		contextWindow: 0,
		contextUsed: 0,
		compacted: false,
		costUsd: 0,
	});

	// Minimal options for shell phase -- only cwd is real
	const shellOpts = { cwd: ctx.cwd, modelId: "", sessionId: "" };

	const { output, input, footer, chrome } = buildLayout(tui, t, shellOpts, tuiStore, true, ctx.buildInfo);
	const { writer } = output;
	const { promptConsole, editor } = input;

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
			() => {},
		).handle,
	);

	tui.start();
	tui.setFocus(editor);
	promptConsole.setStatus(color(bold("INSERT"), t.accentFg));
	tui.requestRender();
	traceEvent("tui:start");

	const stopped = new Promise<void>((resolve) => {
		tui.onStop = () => {
			traceEvent("tui:stop:resolve");
			resolve();
		};
	});

	return {
		tui,
		t,
		output,
		input,
		footer,
		writer,
		editor,
		chrome,
		tuiStore,
		cwd: ctx.cwd,
		handleBootEvent(event) {
			switch (event.phase) {
				case "storage":
					footer.setStatus("boot", event.status === "ready" ? undefined : "storage...");
					break;
				case "session":
					footer.setStatus("boot", event.status === "ready" ? undefined : "session...");
					break;
				case "adapters":
					footer.setStatus("boot", event.status === "ready" ? undefined : "loading adapters...");
					break;
				case "model":
					footer.setStatus("boot", undefined);
					break;
				case "agent":
					footer.setStatus("boot", event.status === "ready" ? undefined : "wiring agent...");
					break;
				case "error":
					writer.addNotice(`Boot error: ${event.error}`);
					footer.setStatus("boot", undefined);
					break;
			}
			tui.requestRender();
		},
		stopped,
	};
}

// ---------------------------------------------------------------------------
// wireSession -- connect a resolved session to the TUI shell
// ---------------------------------------------------------------------------

/**
 * Wire a resolved session into a running TUI shell.
 *
 * All supervisor-layer dependencies arrive through `deps` -- this function
 * never imports from boot/ directly.
 */
export function wireSession(shell: TuiShell, resolved: ResolvedSession, deps: WireSessionDeps): void {
	const { tui, t, output, writer, editor, tuiStore } = shell;
	const { session, store, isNew } = resolved;
	const { replyBlock, replyTW, thinkingTW, forums } = output;
	const { promptConsole, historyProvider } = shell.input;

	tuiStore.update({
		modelId: resolved.modelId,
		thinkingLevel: resolved.getThinking(),
		contextWindow: resolved.contextWindow,
		blueprintName: resolved.blueprintName,
	});

	const opts: InteractiveOptions = {
		cwd: shell.cwd,
		modelId: resolved.modelId,
		sessionId: resolved.sessionId,
		contextWindow: resolved.contextWindow,
		getModel: resolved.getModel,
		setModel: resolved.setModel,
		getThinking: resolved.getThinking,
		setThinking: resolved.setThinking,
		humanAddress: resolved.humanAddress,
		agentAddress: resolved.agentAddress,
		blueprintName: resolved.blueprintName,
		discussion: session.state.discussion?.active,
	};

	let tuiState = initialDispatchState();
	const tuiUi: DispatchPorts = { writer, replyBlock, replyTW, thinkingTW, promptConsole, tui, t, session };
	let liveContextWindow = resolved.contextWindow;

	const eventStream =
		process.env.ALEF_DEBUG === "1" ? createWriteStream("/tmp/alef-events.jsonl", { flags: "w" }) : null;
	const sessionStartedAt = Date.now();

	const dispatch = (event: DispatchEvent): void => {
		if (eventStream) {
			const entry = { offsetMs: Date.now() - sessionStartedAt, event };
			eventStream.write(`${JSON.stringify(entry)}\n`);
		}
		if (event.type === "state-changed") liveContextWindow = event.contextWindow;
		const prev = tuiState;
		const prevContextUsed = tuiStore.get().contextUsed;
		tuiState = dispatchEvent(tuiState, event, tuiUi, deps.signalHandlers);
		syncOverlays(tui, prev.overlays, tuiState.overlays);
		if (event.type === "adapter-signal") {
			if (event.signalType === "context.compacting") {
				shell.footer.setCompacting(event.payload.active === true);
			} else if (event.signalType === "context.compacted") {
				const before = Number(event.payload.estimatedBefore ?? prevContextUsed);
				const after = Number(event.payload.estimatedAfter ?? tuiState.contextFillTokens);
				shell.footer.playDrain(before, after);
			}
		}
		tuiStore.update({
			modelId: session.getModel(),
			inputTokens: tuiState.sessionInputTokens,
			outputTokens: tuiState.sessionOutputTokens,
			contextUsed: tuiState.contextFillTokens,
			contextWindow: liveContextWindow,
			thinkingLevel: session.getThinking(),
			compacted: deps.isCompacted(),
			costUsd: tuiState.sessionCostUsd,
		});
		tui.requestRender();
	};

	// Discussion loading
	let discussionReloadSeq = 0;
	let historyAbort: AbortController | undefined;
	let activeDiscussionKey = opts.discussion ? `${opts.discussion.forumId}/${opts.discussion.topicId}` : "";
	const DISCUSSION_PAINT_CHUNK = 8;

	const loadDiscussion = async (topicId?: string): Promise<void> => {
		if (!session.readDiscussionTopic) return;
		historyAbort?.abort();
		const reloadSeq = ++discussionReloadSeq;
		shell.footer.setStatus("history", "loading\u2026");
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
		if (reloadSeq === discussionReloadSeq) shell.footer.setStatus("history", undefined);
	};

	promptConsole.setTopicLabel(opts.discussion?.topicTitle ?? "");
	promptConsole.onDispatch = (type) => dispatch({ type });

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

	const ctx = createContextFactory(
		t,
		writer,
		tui,
		opts,
		session,
		() => tuiState,
		dispatch,
		store,
		editor,
		deps.rebootPort,
		deps.restartStrategy,
		deps.restartTui
			? {
					exit: async () => {
						if (deps.restartStrategy) return deps.restartStrategy.restart();
						process.exit(75);
					},
					restartTui: () => deps.restartTui!(),
					restartSupervisor:
						deps.restartSupervisor ??
						(async () => {
							if (deps.restartStrategy) return deps.restartStrategy.restart();
							process.exit(75);
						}),
					reloadAdapters:
						deps.reloadAdapters ??
						(async () => {
							if (deps.restartStrategy) return deps.restartStrategy.restart();
							process.exit(75);
						}),
				}
			: undefined,
		deps.buildInfo,
	);

	const historyPickerTheme = createHistoryPickerTheme(t, color, boldColor);
	const historyPickerToggle = (): boolean =>
		openHistoryPicker(historyProvider, historyPickerTheme, (text) => editor.setText(text), dispatch, SelectList);

	tui.onRawInput = (data) => {
		const handled = handleRawInput(data, tuiState, dispatch, ctx, historyPickerToggle);
		if (handled) tui.requestRender();
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

	// Rewire modal handler with colon commands
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

	if (session.readDiscussionTopic) {
		void loadDiscussion();
	} else if (store && !isNew) {
		historyAbort = new AbortController();
		shell.footer.setStatus("history", "loading\u2026");
		void output
			.loadHistory(store, tui, shell.cwd, historyAbort.signal)
			.finally(() => shell.footer.setStatus("history", undefined));
	}

	deps
		.checkForUpdate()
		.then((n) => {
			if (n) {
				writer.addNotice(n);
				const match = n.match(/New version (\S+)/);
				if (match?.[1]) shell.footer.setUpdateAvailable(match[1]);
				tui.requestRender();
			}
		})
		.catch(() => {});

	if (process.env.ALEF_DEBUG === "1") process.stdout.write("[ALEF_READY]\n");
}
