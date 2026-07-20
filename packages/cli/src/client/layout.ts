import type { TUI } from "@dpopsuev/alef-tui";
import { Text } from "@dpopsuev/alef-tui";
import { DashboardFooter, type FooterPanel, OutputPanel, type TuiStateStore } from "@dpopsuev/alef-tui/views";
import type { InteractiveOptions } from "../boot/interactive.js";
import { displayActorName } from "./actor-label.js";
import { createTuiChrome } from "./chrome.js";
import { AtAddressProvider } from "./commands/autocomplete.js";
import { buildPalette, gradientLine, hexToRgb, type Rgb } from "./gradient.js";
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

const PALETTE_STEPS = 24;
const MAX_DARKEN = 0.18;
const MAX_LIGHTEN = 0.18;
const ROW_PHASE_STEP = 0.12;

/** Compose the output panel, input panel, and hint footer into a ready TUI layout. */
export async function buildLayout(
	tui: TUI,
	t: ThemeTokens,
	opts: InteractiveOptions,
	tuiStore: TuiStateStore,
	isNewSession = false,
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

	const humanLabel = displayActorName(opts.humanAddress, "you");
	const agentLabel = displayActorName(opts.agentAddress, "alef");
	const output = new OutputPanel({ tui, t, labels: { humanLabel, agentLabel } });

	// Render splash glyph into the conversation for new sessions only
	const splash = await renderSplash();
	if (isNewSession && splash) {
		const accent = resolveAccentRgb(t);
		const palette = buildPalette(accent, PALETTE_STEPS, MAX_DARKEN, MAX_LIGHTEN);
		const styled = splash.lines.map((line, i) => gradientLine(line, palette, i * ROW_PHASE_STEP)).join("\n");
		const label = color(`${splash.glyph}  ${splash.script}`, t.mutedFg);
		output.writer.container.addChild(new Text(`${styled}\n${label}`, 2, 1));
	}

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

/** Resolve the accent color to RGB from the theme token. */
function resolveAccentRgb(t: ThemeTokens): Rgb {
	if (t.accentFg.truecolor) {
		return hexToRgb(t.accentFg.truecolor) ?? [100, 140, 255];
	}
	return [100, 140, 255];
}
