import { buildModel, resolveProfile } from "@dpopsuev/alef-agent/model";
import { getModels, getProviders } from "@dpopsuev/alef-ai/models";
import type { SettingsListTheme } from "@dpopsuev/alef-tui";
import { type SelectItem, SelectList, type SettingItem, SettingsList } from "@dpopsuev/alef-tui";
import { getConfig } from "../../boot/config.js";
import { color, getActiveThemeName, getProviderColor, setThemeByName } from "../theme.js";
import { buildPickerTheme, openConfigPicker, openEnumPicker, openPicker } from "./overlay-picker.js";
import { type Command, completeCommandArguments, type SettingsCmdCtx } from "./types.js";

const PICKER_MAX_VISIBLE = 12;
const SETTINGS_MAX_VISIBLE = 10;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const THEMES = ["terminal", "terminal-light", "akko", "mono", "matrix"] as const;

/** Detect whether Anthropic API calls are routed through Google Vertex AI. */
function isAnthropicViaVertex(): boolean {
	/* eslint-disable @typescript-eslint/prefer-nullish-coalescing -- empty string from trim() must fall through */
	const projectId =
		process.env.ANTHROPIC_VERTEX_PROJECT_ID?.trim() ||
		process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
		process.env.GCLOUD_PROJECT?.trim();
	const region = process.env.CLOUD_ML_REGION?.trim() || process.env.GOOGLE_CLOUD_LOCATION?.trim();
	/* eslint-enable @typescript-eslint/prefer-nullish-coalescing */
	return Boolean(projectId && region);
}

/** Build the SettingsList theme from the active TUI color tokens. */
export function buildSettingsTheme(ctx: SettingsCmdCtx): SettingsListTheme {
	return {
		label: (s: string, sel: boolean) => (sel ? color(s, ctx.t.accentFg) : s),
		value: (s: string, sel: boolean) => (sel ? color(s, ctx.t.accentFg) : color(s, ctx.t.mutedFg)),
		description: (s: string) => color(s, ctx.t.mutedFg),
		cursor: color("\u2192 ", ctx.t.accentFg),
		hint: (s: string) => color(s, ctx.t.mutedFg),
	};
}

/** Build the list of selectable model items from the active profile or all providers. */
function buildModelItems(): SelectItem[] {
	const cfg = getConfig();
	const profile = resolveProfile(cfg);
	const viaVertex = isAnthropicViaVertex();
	const items: SelectItem[] = [];

	if (profile) {
		for (const entry of profile.models) {
			const pc = getProviderColor(entry.provider);
			const routeSuffix = entry.provider === "anthropic" && viaVertex ? " (via Vertex)" : "";
			const id = `${entry.provider}/${entry.model.id}`;
			const providerLabel = color(`${entry.provider}${routeSuffix}`, pc.token);
			items.push({
				value: id,
				label: `${providerLabel}/${entry.model.id}`,
				description: entry.model.name !== entry.model.id ? entry.model.name : undefined,
			});
		}
		return items;
	}

	for (const provider of getProviders()) {
		const pc = getProviderColor(provider);
		const routeSuffix = provider === "anthropic" && viaVertex ? " (via Vertex)" : "";
		for (const m of getModels(provider)) {
			const id = `${provider}/${m.id}`;
			const providerLabel = color(`${provider}${routeSuffix}`, pc.token);
			items.push({
				value: id,
				label: `${providerLabel}/${m.id}`,
				description: m.name !== m.id ? m.name : undefined,
			});
		}
	}
	return items;
}

/** Create a searchable SelectList submenu for browsing and selecting an LLM model. */
function buildModelSubmenu(currentValue: string, done: (value?: string) => void, ctx: SettingsCmdCtx) {
	const items = buildModelItems().map((item) => ({
		...item,
		label: currentValue.includes(item.value.split("/").pop() ?? "") ? `${item.label} *` : item.label,
	}));
	const pickerTheme = buildPickerTheme(ctx.t);
	const list = new SelectList(items, PICKER_MAX_VISIBLE, pickerTheme).enableSearch();
	list.onSelect = (item: SelectItem) => {
		try {
			buildModel(item.value);
			done(item.value);
		} catch (e) {
			ctx.writer.addNotice(`Failed: ${e instanceof Error ? e.message : String(e)}`);
			done();
		}
	};
	list.onCancel = () => done();
	return list;
}

/** Create a theme enum picker submenu. */
function buildThemeSubmenu(_currentValue: string, done: (value?: string) => void, ctx: SettingsCmdCtx) {
	const items: SelectItem[] = THEMES.map((v) => ({
		value: v,
		label: v === getActiveThemeName() ? `${v} *` : v,
	}));
	const pickerTheme = buildPickerTheme(ctx.t);
	const list = new SelectList(items, THEMES.length, pickerTheme);
	list.onSelect = (item: SelectItem) => {
		setThemeByName(item.value);
		done(item.value);
		ctx.tui.requestRender(true);
	};
	list.onCancel = () => done();
	return list;
}

/** Create a profile picker submenu. */
function buildProfileSubmenu(_currentValue: string, done: (value?: string) => void, ctx: SettingsCmdCtx) {
	const cfg = getConfig();
	const names = cfg.profiles ? Object.keys(cfg.profiles) : [];
	if (names.length === 0) {
		ctx.writer.addNotice("No profiles defined in config.yaml.");
		done();
		return new (class NullComponent {
			render() {
				return [];
			}
			invalidate() {}
		})();
	}
	const items: SelectItem[] = names.map((n) => {
		const p = cfg.profiles?.[n];
		const active = n === cfg.profile;
		return {
			value: n,
			label: active ? `${n} *` : n,
			description: p ? `${p.providers.join(", ")}${p.default ? ` > ${p.default}` : ""}` : "",
		};
	});
	const pickerTheme = buildPickerTheme(ctx.t);
	const list = new SelectList(items, 6, pickerTheme);
	list.onSelect = (item: SelectItem) => {
		const resolved = resolveProfile({ ...cfg, profile: item.value });
		const defaultModel = resolved?.defaultModel;
		if (defaultModel) {
			try {
				buildModel(defaultModel);
				ctx.session.setModel(defaultModel);
			} catch {
				// default model not valid
			}
		}
		done(item.value);
	};
	list.onCancel = () => done();
	return list;
}

/** Open the combined model + thinking settings overlay. */
function openModelPicker(ctx: SettingsCmdCtx): void {
	const settingsItems: SettingItem[] = [
		{
			id: "model",
			label: "Model",
			currentValue: ctx.session.getModel(),
			description: "LLM model (persists across restarts). Enter to browse.",
			submenu: (currentValue, done) => buildModelSubmenu(currentValue, done, ctx),
		},
		{
			id: "thinking",
			label: "Thinking",
			currentValue: ctx.session.getThinking(),
			values: [...THINKING_LEVELS],
			description: "Extended thinking depth. Tab/Shift+Tab to cycle.",
		},
	];

	const close = () => {
		ctx.dispatch({ type: "overlay.hide", id: "model-picker" });
		ctx.tui.requestRender();
	};

	const settingsTheme = buildSettingsTheme(ctx);
	const list = new SettingsList(
		settingsItems,
		SETTINGS_MAX_VISIBLE,
		settingsTheme,
		(id, value) => {
			if (id === "model") {
				ctx.session.setModel(value);
				ctx.writer.addNotice(`Model switched to ${value}.`);
			}
			if (id === "thinking") {
				ctx.session.setThinking(value);
				ctx.writer.addNotice(`Thinking set to "${value}".`);
			}
			close();
		},
		close,
	);

	ctx.dispatch({
		type: "overlay.show",
		descriptor: { id: "model-picker", component: list, handleInput: (d: string) => list.handleInput(d) },
	});
}

/** Open the unified settings overlay with all runtime settings. */
function openSettingsOverlay(ctx: SettingsCmdCtx): void {
	const cfg = getConfig();
	const profileNames = cfg.profiles ? Object.keys(cfg.profiles) : [];

	const settingsItems: SettingItem[] = [
		{
			id: "model",
			label: "Model",
			currentValue: ctx.session.getModel(),
			description: "LLM model. Enter to browse available models.",
			submenu: (currentValue, done) => buildModelSubmenu(currentValue, done, ctx),
		},
		{
			id: "thinking",
			label: "Thinking",
			currentValue: ctx.session.getThinking(),
			values: [...THINKING_LEVELS],
			description: "Extended thinking depth. Tab/Shift+Tab to cycle.",
		},
		{
			id: "theme",
			label: "Theme",
			currentValue: getActiveThemeName(),
			description: "Color theme. Enter to browse.",
			submenu: (currentValue, done) => buildThemeSubmenu(currentValue, done, ctx),
		},
	];

	if (profileNames.length > 0) {
		settingsItems.push({
			id: "profile",
			label: "Profile",
			currentValue: cfg.profile ?? "default",
			description: "Model profile (provider/model subsets). Enter to browse.",
			submenu: (currentValue, done) => buildProfileSubmenu(currentValue, done, ctx),
		});
	}

	const close = () => {
		ctx.dispatch({ type: "overlay.hide", id: "settings" });
		ctx.tui.requestRender();
	};

	const settingsTheme = buildSettingsTheme(ctx);
	const list = new SettingsList(
		settingsItems,
		SETTINGS_MAX_VISIBLE,
		settingsTheme,
		(id, value) => {
			switch (id) {
				case "model":
					ctx.session.setModel(value);
					ctx.writer.addNotice(`Model switched to ${value}.`);
					break;
				case "thinking":
					ctx.session.setThinking(value);
					ctx.writer.addNotice(`Thinking set to "${value}".`);
					break;
				case "theme":
					setThemeByName(value);
					ctx.writer.addNotice(`Theme set to '${value}'.`);
					ctx.tui.requestRender(true);
					break;
				case "profile": {
					const resolved = resolveProfile({ ...cfg, profile: value });
					const count = resolved?.models.length ?? 0;
					const defaultModel = resolved?.defaultModel;
					if (defaultModel) {
						try {
							buildModel(defaultModel);
							ctx.session.setModel(defaultModel);
						} catch {
							// default model not valid
						}
					}
					ctx.writer.addNotice(
						`Profile "${value}" active -- ${count} models.${defaultModel ? ` Default: ${defaultModel}` : ""}`,
					);
					break;
				}
			}
			close();
		},
		close,
	);

	ctx.dispatch({
		type: "overlay.show",
		descriptor: { id: "settings", component: list, handleInput: (d: string) => list.handleInput(d) },
	});
}

export const settings: Command = {
	name: "settings",
	description: "Open settings overlay",
	run(ctx: SettingsCmdCtx) {
		openSettingsOverlay(ctx);
	},
};

export const theme: Command = {
	name: "theme",
	description: "Switch theme",
	argumentHint: "<name>",
	getArgumentCompletions: (prefix) =>
		completeCommandArguments(
			THEMES.map((value) => ({ value, description: "Theme" })),
			prefix,
		),
	run(ctx: SettingsCmdCtx, args: string[]) {
		const name = args[0]?.toLowerCase();
		if (name) {
			if (!(THEMES as readonly string[]).includes(name)) {
				ctx.writer.addNotice(`Unknown theme '${name}'. Available: ${THEMES.join(", ")}`);
				ctx.tui.requestRender();
				return;
			}
			setThemeByName(name);
			ctx.writer.addNotice(`Theme set to '${name}'.`);
			ctx.tui.requestRender(true);
			return;
		}
		openEnumPicker(ctx.t, ctx.dispatch, () => ctx.tui.requestRender(), {
			id: "theme-picker",
			values: THEMES,
			onSelect: (value) => {
				setThemeByName(value);
				ctx.writer.addNotice(`Theme set to '${value}'.`);
				ctx.tui.requestRender(true);
			},
		});
	},
};

export const model: Command = {
	name: "model",
	description: "Switch model -- :model or :model <id>",
	run(ctx: SettingsCmdCtx, args: string[]) {
		const [newId] = args;
		if (newId) {
			try {
				buildModel(newId);
				ctx.session.setModel(newId);
				ctx.writer.addNotice(`Model switched to ${newId}.`);
			} catch (e) {
				ctx.writer.addNotice(`Unknown model: ${newId}. ${e instanceof Error ? e.message : ""}`);
			}
			ctx.tui.requestRender();
			return;
		}
		openModelPicker(ctx);
	},
};

export const think: Command = {
	name: "think",
	description: "Set thinking level",
	argumentHint: "off | minimal | low | medium | high | xhigh",
	getArgumentCompletions: (prefix) =>
		completeCommandArguments(
			THINKING_LEVELS.map((value) => ({ value, description: "Thinking level" })),
			prefix,
		),
	run(ctx: SettingsCmdCtx, args: string[]) {
		const [level] = args;
		if (level) {
			if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
				ctx.writer.addNotice(`Unknown level: ${level}. Valid: ${THINKING_LEVELS.join(" | ")}`);
				ctx.tui.requestRender();
				return;
			}
			ctx.session.setThinking(level);
			ctx.writer.addNotice(`Thinking set to "${level}".`);
			ctx.tui.requestRender();
			return;
		}
		openEnumPicker(ctx.t, ctx.dispatch, () => ctx.tui.requestRender(), {
			id: "think-picker",
			values: THINKING_LEVELS,
			active: ctx.session.getThinking(),
			onSelect: (value) => {
				ctx.session.setThinking(value);
				ctx.writer.addNotice(`Thinking set to "${value}".`);
				ctx.tui.requestRender();
			},
		});
	},
};

export const profile: Command = {
	name: "profile",
	description: "Switch model profile -- :profile or :profile <name>",
	run(ctx: SettingsCmdCtx, args: string[]) {
		const cfg = getConfig();
		const names = cfg.profiles ? Object.keys(cfg.profiles) : [];
		if (names.length === 0) {
			ctx.writer.addNotice("No profiles defined in config.yaml.");
			ctx.tui.requestRender();
			return;
		}

		const applyProfile = (name: string) => {
			if (!cfg.profiles?.[name]) {
				ctx.writer.addNotice(`Unknown profile: ${name}. Available: ${names.join(", ")}`);
				ctx.tui.requestRender();
				return;
			}
			const resolved = resolveProfile({ ...cfg, profile: name });
			const count = resolved?.models.length ?? 0;
			const defaultModel = resolved?.defaultModel;
			if (defaultModel) {
				try {
					buildModel(defaultModel);
					ctx.session.setModel(defaultModel);
				} catch {
					// default model not valid -- ignore
				}
			}
			ctx.writer.addNotice(
				`Profile "${name}" active -- ${count} models.${defaultModel ? ` Default: ${defaultModel}` : ""}`,
			);
			ctx.tui.requestRender();
		};

		const [name] = args;
		if (name) {
			applyProfile(name);
			return;
		}

		const items: SelectItem[] = names.map((n) => {
			const p = cfg.profiles?.[n];
			const active = n === cfg.profile;
			return {
				value: n,
				label: active ? `${n} *` : n,
				description: p ? `${p.providers.join(", ")}${p.default ? ` > ${p.default}` : ""}` : "",
			};
		});

		openPicker(ctx.t, ctx.dispatch, () => ctx.tui.requestRender(), {
			id: "profile-picker",
			items,
			maxVisible: 6,
			onSelect: (item) => {
				applyProfile(item.value);
			},
		});
	},
};

export const skills: Command = {
	name: "skills",
	description: "Browse and invoke skills -- :skills or :skills <name>",
	async run(ctx: SettingsCmdCtx, args: string[]) {
		const [name] = args;
		if (name) {
			ctx.writer.addNotice(`Loading skill '${name}'... Use skills.invoke({ name: "${name}" }) in the chat.`);
			ctx.tui.requestRender();
			return;
		}
		let discovered: Array<{ name: string; description: string; path: string }> = [];
		try {
			const discovery = await import("../../../../tools/skills/src/discovery.js");
			discovered = discovery.discoverSkills(ctx.opts?.cwd ?? process.cwd());
		} catch {
			ctx.writer.addNotice("Skills discovery not available.");
			ctx.tui.requestRender();
			return;
		}
		if (discovered.length === 0) {
			ctx.writer.addNotice("No skills found.");
			ctx.tui.requestRender();
			return;
		}
		openConfigPicker(ctx.t, ctx.dispatch, () => ctx.tui.requestRender(), {
			id: "skills-picker",
			source: () => discovered,
			toItem: (s) => ({ value: s.name, label: s.name, description: s.description }),
			onSelect: (s) => {
				ctx.writer.addNotice(`Skill '${s.name}' at ${s.path}\nUse: skills.invoke({ name: "${s.name}" })`);
				ctx.tui.requestRender();
			},
		});
	},
};
