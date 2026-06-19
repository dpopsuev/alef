import type { ISessionStore } from "@dpopsuev/alef-session";
import type { TUI } from "@dpopsuev/alef-tui";
import { CombinedAutocompleteProvider, Container, type SlashCommand, Text } from "@dpopsuev/alef-tui";
import { registry } from "./commands/index.js";
import { AtAddressProvider, HistoryAutocompleteProvider } from "./history-autocomplete.js";
import type { InteractiveOptions } from "./interactive.js";
import { PromptConsole } from "./prompt-console.js";
import { renderSplash } from "./splash.js";
import { boldColor, glyph, type ThemeTokens } from "./theme.js";
import { ChatLog } from "./tui/chat-log.js";
import { DynamicText } from "./tui/dynamic-text.js";
import { ReplyBlock } from "./tui/reply-block.js";
import { prependSessionHistory } from "./tui/session-history.js";
import { Typewriter } from "./tui/typewriter.js";

export interface TuiLayout {
	writer: ChatLog;
	replyBlock: ReplyBlock;
	replyTW: Typewriter;
	thinkingTW: Typewriter;
	promptConsole: PromptConsole;
	historyProvider: HistoryAutocompleteProvider;
}

export async function buildLayout(
	tui: TUI,
	t: ThemeTokens,
	opts: InteractiveOptions,
	getTokensTotal: () => number,
	store?: ISessionStore,
): Promise<TuiLayout> {
	const sessionShort = opts.sessionId.slice(0, 8);
	const modelShort = opts.modelId.split("/").pop()?.split(" ")[0] ?? opts.modelId;

	const headerLabel = () => {
		const base = `${glyph("bullet")} ALEF  ${glyph("sep")}  ${sessionShort}  ${glyph("sep")}  ${modelShort}`;
		const total = getTokensTotal();
		if (total === 0) return base;
		const fmt =
			total >= 1_000_000
				? `${(total / 1_000_000).toFixed(1)}M`
				: total >= 1_000
					? `${Math.round(total / 1_000)}k`
					: String(total);
		return `${base}  ${glyph("sep")}  ${fmt} tok`;
	};

	tui.addChild(new DynamicText(() => boldColor(headerLabel(), t.accentFg)));
	const splash = await renderSplash();
	if (splash) tui.addChild(new Text(splash, 2, 0));

	const chat = new Container();
	tui.addChild(chat);

	const promptConsole = new PromptConsole(tui, t, opts.modelId);
	promptConsole.mount();
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

	return { writer, replyBlock, replyTW, thinkingTW, promptConsole, historyProvider };
}
