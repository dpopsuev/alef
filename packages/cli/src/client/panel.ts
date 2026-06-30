import { execSync } from "node:child_process";
import {
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	type Editor,
	type SlashCommand,
	type TUI,
} from "@dpopsuev/alef-tui";
import { InputApplicationRegistry } from "./application.js";
import { HistoryAutocompleteProvider } from "./commands/autocomplete.js";
import { registry } from "./commands/commands.js";
import { PromptConsole } from "./console.js";
import type { ThemeTokens } from "./theme/theme.js";

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
