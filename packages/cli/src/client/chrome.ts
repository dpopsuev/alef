/**
 * Thin TUI chrome host — Pi ExtensionUIContext subset for progressive disclosure.
 */

import type { DashboardFooter } from "@dpopsuev/alef-tui/views";
import type { DockConsole } from "./console.js";
import type { InputApplicationFactory, InputApplicationRegistry } from "./panel.js";

/** Pi-shaped chrome contributions used by interactive mode and adapters. */
export interface TuiChrome {
	setStatus(key: string, text: string | undefined): void;
	setWidget(key: string, lines: string[] | undefined): void;
	setHint(text: string): void;
	registerColonApp(name: string, factory: InputApplicationFactory): void;
}

/** Inputs required to host Pi-shaped chrome contributions. */
export interface TuiChromeOptions {
	footer: DashboardFooter;
	console: DockConsole;
	applications: InputApplicationRegistry;
}

/** Wire footer/console/input apps into a single chrome surface. */
export function createTuiChrome(opts: TuiChromeOptions): TuiChrome {
	const widgets = new Map<string, string>();

	const flushWidgets = (): void => {
		if (widgets.size === 0) {
			opts.console.setWidgetAbove("");
			return;
		}
		// Prefer the plan status line; otherwise join keyed one-liners.
		const plan = widgets.get("plan");
		if (plan !== undefined) {
			opts.console.setWidgetAbove(plan);
			return;
		}
		opts.console.setWidgetAbove([...widgets.values()].filter(Boolean).join(" · "));
	};

	return {
		setStatus(key, text) {
			opts.footer.setStatus(key, text);
		},
		setWidget(key, lines) {
			if (!lines || lines.length === 0) {
				widgets.delete(key);
			} else {
				widgets.set(key, lines[0] ?? "");
			}
			flushWidgets();
		},
		setHint(text) {
			// Coaching / whichkey / Tab live as dim typewriter ghosts in the input.
			opts.console.setHint(text);
		},
		registerColonApp(name, factory) {
			opts.applications.register(name, factory);
		},
	};
}
