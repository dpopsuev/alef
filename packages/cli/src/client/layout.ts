import type { TUI } from "@dpopsuev/alef-tui";
import { Text } from "@dpopsuev/alef-tui";
import { DashboardFooter, type FooterPanel, OutputPanel, type TuiStateStore } from "@dpopsuev/alef-tui/views";
import type { InteractiveOptions } from "../boot/interactive.js";
import { displayActorName } from "./actor-label.js";
import { createTuiChrome } from "./chrome.js";
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
 *     upper delimiter — plain rule; topic title on the right once named
 *     input box       — Editor: vi-modal text, multiline, autocomplete
 *     lower delimiter — ─ NORMAL ────── compacted … ─ (mode left, notices right)
 *     hints/app       — editor :command SelectList (below lower delimiter), or InputApplication
 *
 *   FOOTER
 *     context bar     — compact context spark (blink on compact, drain on recover)
 *     meta            — path · model · blueprint (coaching hints live in the empty input)
 */

/** The three top-level zones of the TUI: output, input, and footer. */
export interface TuiLayout {
	output: OutputPanel;
	input: InputPanel;
	footer: FooterPanel;
	chrome: ReturnType<typeof createTuiChrome>;
}

/** Compose the output panel, input panel, and hint footer into a ready TUI layout. */
export async function buildLayout(
	tui: TUI,
	t: ThemeTokens,
	opts: InteractiveOptions,
	tuiStore: TuiStateStore,
): Promise<TuiLayout> {
	const { BUILD_INFO } = await import("../boot/build-info.js");
	const dashboard = new DashboardFooter({
		sessionId: opts.sessionId,
		cwd: opts.cwd,
		store: tuiStore,
		blueprintName: opts.blueprintName,
		requestRender: () => tui.requestRender(),
		style: (s) => boldColor(s, t.accentFg),
		dimStyle: (s) => color(s, t.mutedFg),
		warnStyle: (s) => color(s, t.warnFg),
		errorStyle: (s) => color(s, t.errFg),
		buildInfo: BUILD_INFO,
	});

	const splash = await renderSplash();
	if (splash) tui.addChild(new Text(splash, 2, 0));

	const humanLabel = displayActorName(opts.humanAddress, "you");
	const agentLabel = displayActorName(opts.agentAddress, "alef");
	const output = new OutputPanel({ tui, t, labels: { humanLabel, agentLabel } });

	const input = new InputPanel({
		tui,
		t,
		modelId: opts.modelId,
		cwd: opts.cwd,
		atProvider: opts.actorRoutes ? new AtAddressProvider(opts.actorRoutes) : undefined,
	});

	const chrome = createTuiChrome({
		footer: dashboard,
		console: input.promptConsole,
		applications: input.applications,
	});

	tui.addChild(dashboard);

	return { output, input, footer: dashboard, chrome };
}
