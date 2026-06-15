import type { ISessionStore } from "@dpopsuev/alef-session";
import type { TUI } from "@dpopsuev/alef-tui";
import { Container, Text } from "@dpopsuev/alef-tui";
import { ConsoleZone } from "./console-zone.js";
import { AtAddressProvider, HistoryAutocompleteProvider } from "./history-autocomplete.js";
import type { InteractiveOptions } from "./interactive.js";
import { renderSplash } from "./splash.js";
import { boldColor, glyph, type ThemeTokens } from "./theme.js";
import { ChatWriter } from "./tui/chat-writer.js";
import { DynamicText } from "./tui/dynamic-text.js";
import { prependSessionHistory } from "./tui/session-history.js";
import { StreamingZone } from "./tui/streaming-zone.js";
import { Typewriter } from "./tui/typewriter.js";

export interface TuiLayout {
	writer: ChatWriter;
	streamingZone: StreamingZone;
	replyTW: Typewriter;
	thinkingTW: Typewriter;
	consoleZone: ConsoleZone;
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

	tui.addChild(
		new DynamicText((w) => {
			const inner = `─ ${headerLabel()} `;
			return boldColor(`╭${inner}${"─".repeat(Math.max(0, w - inner.length - 2))}╮`, t.accentFg);
		}),
	);
	const splash = await renderSplash();
	if (splash) tui.addChild(new Text(splash, 2, 0));
	tui.addChild(new DynamicText((w) => boldColor(`╰${"─".repeat(Math.max(0, w - 2))}╯`, t.accentFg)));

	const chat = new Container();
	tui.addChild(chat);

	const consoleZone = new ConsoleZone(tui, t, opts.modelId);
	consoleZone.mount();
	const { editor } = consoleZone;

	const historyProvider = new HistoryAutocompleteProvider();
	if (editor.setAutocompleteProvider) {
		if (opts.actorRoutes) {
			// Two providers: @-address takes priority when line starts with @, else history
			const atProvider = new AtAddressProvider(opts.actorRoutes);
			editor.setAutocompleteProvider({
				getSuggestions: (lines, cursorLine, cursorCol, options) => {
					const prefix = (lines[cursorLine] ?? "").slice(0, cursorCol);
					if (prefix.startsWith("@")) return atProvider.getSuggestions(lines, cursorLine, cursorCol, options);
					return historyProvider.getSuggestions(lines, cursorLine, cursorCol, options);
				},
				applyCompletion: (lines, cursorLine, cursorCol, item, pfx) => {
					if (item.description === "actor")
						return atProvider.applyCompletion(lines, cursorLine, cursorCol, item, pfx);
					return historyProvider.applyCompletion(lines, cursorLine, cursorCol, item, pfx);
				},
			});
		} else {
			editor.setAutocompleteProvider(historyProvider);
		}
	}

	const humanLabel = opts.humanAddress ?? "@you";
	const agentLabel = opts.agentAddress ?? "@alef";
	const writer = new ChatWriter(chat, t, { humanLabel, agentLabel });

	// Eager-load prior session turns (non-blocking — fire-and-forget with render).
	if (store) {
		prependSessionHistory(store, writer, { maxTurns: 5 })
			.then(() => tui.requestRender())
			.catch(() => {});
	}

	const streamingZone = new StreamingZone(chat, () => tui.requestRender(), t, true, agentLabel);
	const replyTW = new Typewriter(
		(delta) => streamingZone.receiveText(delta),
		() => tui.requestRender(),
	);
	const thinkingTW = new Typewriter(
		(delta) => streamingZone.receiveThinking(delta),
		() => tui.requestRender(),
	);

	return { writer, streamingZone, replyTW, thinkingTW, consoleZone, historyProvider };
}
