import type { SessionStore } from "@dpopsuev/alef-session/storage";
import type { TUI } from "@dpopsuev/alef-tui";
import { Text } from "@dpopsuev/alef-tui";
import { DashboardFooter, type FooterPanel, OutputPanel, type TuiStateStore } from "@dpopsuev/alef-tui/views";
import type { InteractiveOptions } from "../boot/interactive.js";
import { AtAddressProvider } from "./commands/autocomplete.js";
import { renderSplash } from "./greeter.js";
import { InputPanel } from "./panel.js";
import { boldColor, color, type ThemeTokens } from "./theme.js";

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

/** The three top-level zones of the TUI: output, input, and footer. */
export interface TuiLayout {
	output: OutputPanel;
	input: InputPanel;
	footer: FooterPanel;
}

/** Compose the output panel, input panel, and dashboard footer into a ready TUI layout. */
export async function buildLayout(
	tui: TUI,
	t: ThemeTokens,
	opts: InteractiveOptions,
	tuiStore: TuiStateStore,
	store?: SessionStore,
): Promise<TuiLayout> {
	const { BUILD_INFO } = await import("../boot/build-info.js");
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
