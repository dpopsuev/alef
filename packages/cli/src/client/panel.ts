import { execSync } from "node:child_process";
import {
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	type Component,
	type Editor,
	type SlashCommand,
	type TUI,
} from "@dpopsuev/alef-tui";
import { HistoryAutocompleteProvider } from "./commands/autocomplete.js";
import { registry } from "./commands/commands.js";
import { PromptConsole } from "./console.js";
import type { ThemeTokens } from "./theme.js";

export interface InputPanelOptions {
	tui: TUI;
	t: ThemeTokens;
	modelId: string;
	cwd: string;
	atProvider?: AutocompleteProvider;
}

export class InputPanel {
	readonly promptConsole: PromptConsole;
	readonly historyProvider: HistoryAutocompleteProvider;
	readonly applications: InputApplicationRegistry;
	readonly editor: Editor;

	constructor(opts: InputPanelOptions) {
		const { tui, t, modelId, cwd } = opts;

		this.promptConsole = new PromptConsole(tui, t, modelId);
		this.promptConsole.mount();
		this.editor = this.promptConsole.editor;
		this.historyProvider = new HistoryAutocompleteProvider();
		this.applications = new InputApplicationRegistry();

		this.wireAutocomplete(cwd, opts.atProvider);
	}

	private wireAutocomplete(cwd: string, atProvider?: AutocompleteProvider): void {
		const commands: SlashCommand[] = registry.list().map((c) => ({
			name: c.name,
			description: c.description,
		}));

		let fdPath: string | null = null;
		try {
			fdPath = execSync("which fd 2>/dev/null || which fdfind 2>/dev/null", { encoding: "utf-8" }).trim() || null;
		} catch {
			fdPath = null;
		}

		const combinedProvider = new CombinedAutocompleteProvider(commands, cwd, fdPath);
		const { historyProvider } = this;

		this.editor.setAutocompleteProvider({
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
			shouldTriggerFileCompletion: combinedProvider.shouldTriggerFileCompletion.bind(combinedProvider),
		});
	}
}

/**
 * InputApplication — protocol for applications hosted in the input zone.
 *
 * The input zone is a mode-switchable application slot. The default mode
 * is the prompt editor. :commands launch applications that take over
 * the input zone with their own rendering and keybindings.
 *
 * Lifecycle:
 *   :session → InputApplication.mount() → renders in input zone
 *   user interacts → handleInput() routes keys to the application
 *   Esc or result → onDismiss(result) → returns to prompt editor
 *
 * Composition:
 *   ┌──────────────────────────────┐
 *   │  INPUT ZONE                  │
 *   │  ┌────────────────────────┐  │
 *   │  │ active application     │  │  ← InputApplication.render()
 *   │  │ (editor / picker / app)│  │
 *   │  ├────────────────────────┤  │
 *   │  │ reactive sub-elements  │  │  ← autocomplete, hints, etc.
 *   │  └────────────────────────┘  │
 *   └──────────────────────────────┘
 */

export interface InputApplicationResult {
	/** Value returned to the prompt or action system. */
	value?: string;
	/** Action to take (e.g. "switch-session", "select-blueprint"). */
	action?: string;
}

export interface InputApplication {
	/** Unique name for this application. */
	readonly name: string;

	/** Component that renders in the input zone. */
	readonly view: Component;

	/** Called when the application is mounted into the input zone. */
	onMount?(): void;

	/**
	 * Called when the application is dismissed.
	 * Return a result to feed back into the prompt or trigger an action.
	 */
	onDismiss?(): InputApplicationResult | undefined;
}

export type InputApplicationFactory = (args: string) => InputApplication | undefined;

/**
 * Registry of :command → InputApplication factories.
 *
 * Usage:
 *   registry.register("session", (args) => new SessionPickerApp());
 *   registry.register("blueprint", (args) => new BlueprintPickerApp());
 *
 *   const app = registry.resolve("session");
 *   if (app) inputZone.activate(app);
 */
export class InputApplicationRegistry {
	private readonly factories = new Map<string, InputApplicationFactory>();

	register(command: string, factory: InputApplicationFactory): void {
		this.factories.set(command, factory);
	}

	resolve(command: string, args = ""): InputApplication | undefined {
		const factory = this.factories.get(command);
		return factory?.(args);
	}

	list(): string[] {
		return [...this.factories.keys()];
	}
}
