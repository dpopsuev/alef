import type { SessionStore } from "@dpopsuev/alef-session";
import type { TUI } from "@dpopsuev/alef-tui";
import { Text } from "@dpopsuev/alef-tui";
import { DashboardFooter, type FooterPanel, OutputPanel, type TuiStateStore } from "@dpopsuev/alef-tui/views";
import type { InteractiveOptions } from "../interactive.js";
import { AtAddressProvider } from "./history-autocomplete.js";
import { InputPanel } from "./input-panel.js";
import { boldColor, color, type ThemeTokens } from "./runner-theme.js";
import { renderSplash } from "./splash.js";

/**
 * TUI Composition Model:
 *
 *   OUTPUT
 *     scrollback      — ChatLog: append-only conversation history (static)
 *     streaming       — ReplyBlock + Typewriters: live agent response (dynamic)
 *     spinner/fsm     — Thinking indicator, tool call status (dynamic)
 *     forums          — AgentForum: discourse channel switching
 *
 *   INPUT
 *     upper delimiter — ─────────────────────────── (plain rule)
 *     input box       — Editor: vi-modal text, multiline, autocomplete
 *     lower delimiter — ─ NORMAL ─────────────────── (mode label embedded)
 *     hints/app       — Vim hints, :command grid, or InputApplication
 *
 *   FOOTER
 *     dashboard       — cwd (branch) │ session │ model │ tokens │ ctx battery bar
 */

export interface TuiLayout {
	output: OutputPanel;
	input: InputPanel;
	footer: FooterPanel;
}

export async function buildLayout(
	tui: TUI,
	t: ThemeTokens,
	opts: InteractiveOptions,
	tuiStore: TuiStateStore,
	store?: SessionStore,
): Promise<TuiLayout> {
	const { BUILD_INFO } = await import("../build-info.js");
	const dashboard = new DashboardFooter({
		sessionId: opts.sessionId,
		cwd: opts.cwd,
		store: tuiStore,
		requestRender: () => tui.requestRender(),
		style: (s) => boldColor(s, t.accentFg),
		dimStyle: (s) => color(s, t.mutedFg),
		warnStyle: (s) => color(s, { ansi16: 93 }),
		errorStyle: (s) => color(s, { ansi16: 91 }),
		buildInfo: BUILD_INFO,
	});

	const splash = await renderSplash();
	if (splash) tui.addChild(new Text(splash, 2, 0));

	const humanLabel = opts.humanAddress ?? "@you";
	const agentLabel = opts.agentAddress ?? "@alef";
	const output = new OutputPanel({ tui, t, labels: { humanLabel, agentLabel } });
	if (store) output.loadHistory(store, tui);

	const input = new InputPanel({
		tui,
		t,
		modelId: opts.modelId,
		cwd: opts.cwd,
		atProvider: opts.actorRoutes ? new AtAddressProvider(opts.actorRoutes) : undefined,
	});

	tui.addChild(dashboard);

	return { output, input, footer: dashboard };
}
