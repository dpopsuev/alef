import type { ISessionStore } from "@dpopsuev/alef-session";
import type { TUI } from "@dpopsuev/alef-tui";
import { CombinedAutocompleteProvider, Container, type SlashCommand, Text } from "@dpopsuev/alef-tui";
import { registry } from "./commands/index.js";
import { AtAddressProvider, HistoryAutocompleteProvider } from "./history-autocomplete.js";
import { InputApplicationRegistry } from "./input-application.js";
import type { InteractiveOptions } from "./interactive.js";
import { PromptConsole } from "./prompt-console.js";
import { renderSplash } from "./splash.js";
import { boldColor, color, type ThemeTokens } from "./theme.js";
import { ChatLog } from "./tui/chat-log.js";
import { DashboardFooter } from "./tui/dashboard-footer.js";
import { ForumManager } from "./tui/forum-manager.js";
import { ReplyBlock } from "./tui/reply-block.js";
import { prependSessionHistory } from "./tui/session-history.js";
import { Typewriter } from "./tui/typewriter.js";

/**
 * TUI Composition Model:
 *
 *   OUTPUT ZONE
 *     scrollback  — ChatLog: append-only conversation history (static)
 *     live        — ReplyBlock + Typewriters: streaming response, thinking (dynamic)
 *     forums      — ForumManager: discourse channel switching
 *
 *   INPUT ZONE
 *     editor      — PromptConsole: vi-modal text editor
 *     history     — HistoryAutocompleteProvider: input history + autocomplete
 *     (future: InputApplication slot for :command apps)
 *
 *   DASHBOARD (in header — future: move to footer)
 *     session ID, model, token count, key hints
 */

export interface OutputZone {
	/** Append-only conversation history (scrollback). */
	scrollback: ChatLog;
	/** Live streaming response + thinking indicator (dynamic, commits to scrollback when done). */
	live: {
		replyBlock: ReplyBlock;
		replyTW: Typewriter;
		thinkingTW: Typewriter;
	};
	/** Discourse channel switching. */
	forums: ForumManager;
}

export interface InputZone {
	/** Vi-modal prompt editor. */
	promptConsole: PromptConsole;
	/** Input history + autocomplete provider. */
	historyProvider: HistoryAutocompleteProvider;
	/** :command → InputApplication registry for mode-switchable apps. */
	applications: InputApplicationRegistry;
}

export interface TuiLayout {
	output: OutputZone;
	input: InputZone;
}

export async function buildLayout(
	tui: TUI,
	t: ThemeTokens,
	opts: InteractiveOptions,
	getTokensTotal: () => number,
	store?: ISessionStore,
): Promise<TuiLayout> {
	const dashboard = new DashboardFooter({
		sessionId: opts.sessionId,
		modelId: opts.modelId,
		cwd: opts.cwd ?? process.cwd(),
		getTokensTotal,
		style: (s) => boldColor(s, t.accentFg),
		dimStyle: (s) => color(s, t.mutedFg),
	});

	const splash = await renderSplash();
	if (splash) tui.addChild(new Text(splash, 2, 0));

	const chatParent = new Container();
	tui.addChild(chatParent);
	const chat = new Container();
	chatParent.addChild(chat);
	const forums = new ForumManager(chatParent, chat);

	const promptConsole = new PromptConsole(tui, t, opts.modelId);
	promptConsole.mount();

	// Dashboard footer — pinned at the bottom, after the prompt console
	tui.addChild(dashboard);
	const { editor } = promptConsole;

	const commands: SlashCommand[] = registry.list().map((c) => ({
		name: c.name,
		description: c.description,
	}));
	let fdPath: string | null = null;
	try {
		const { execSync } = await import("node:child_process");
		fdPath = execSync("which fd 2>/dev/null || which fdfind 2>/dev/null", { encoding: "utf-8" }).trim() || null;
	} catch {
		fdPath = null;
	}
	const combinedProvider = new CombinedAutocompleteProvider(commands, opts.cwd ?? process.cwd(), fdPath);
	const historyProvider = new HistoryAutocompleteProvider();

	if (editor.setAutocompleteProvider) {
		const atProvider = opts.actorRoutes ? new AtAddressProvider(opts.actorRoutes) : null;
		editor.setAutocompleteProvider({
			getSuggestions: (lines, cursorLine, cursorCol, options) => {
				const prefix = (lines[cursorLine] ?? "").slice(0, cursorCol);
				if (prefix.startsWith("@") && atProvider)
					return atProvider.getSuggestions(lines, cursorLine, cursorCol, options);
				if (prefix.startsWith(":")) return combinedProvider.getSuggestions(lines, cursorLine, cursorCol, options);
				return historyProvider.getSuggestions(lines, cursorLine, cursorCol, options);
			},
			applyCompletion: (lines, cursorLine, cursorCol, item, pfx) => {
				if (item.description === "actor" && atProvider)
					return atProvider.applyCompletion(lines, cursorLine, cursorCol, item, pfx);
				if (pfx.startsWith(":")) return combinedProvider.applyCompletion(lines, cursorLine, cursorCol, item, pfx);
				return historyProvider.applyCompletion(lines, cursorLine, cursorCol, item, pfx);
			},
			shouldTriggerFileCompletion: combinedProvider.shouldTriggerFileCompletion?.bind(combinedProvider),
		});
	}

	const humanLabel = opts.humanAddress ?? "@you";
	const agentLabel = opts.agentAddress ?? "@alef";
	const writer = new ChatLog(chat, t, { humanLabel, agentLabel });

	// Eager-load prior session turns (non-blocking — fire-and-forget with render).
	if (store) {
		prependSessionHistory(store, writer, { maxTurns: 5 })
			.then(() => tui.requestRender())
			.catch(() => {});
	}

	const replyBlock = new ReplyBlock(chat, () => tui.requestRender(), t, true, agentLabel);
	const replyTW = new Typewriter(
		(delta) => replyBlock.receiveText(delta),
		() => tui.requestRender(),
	);
	const thinkingTW = new Typewriter(
		(delta) => replyBlock.receiveThinking(delta),
		() => tui.requestRender(),
	);

	const applications = new InputApplicationRegistry();

	return {
		output: { scrollback: writer, live: { replyBlock, replyTW, thinkingTW }, forums },
		input: { promptConsole, historyProvider, applications },
	};
}
