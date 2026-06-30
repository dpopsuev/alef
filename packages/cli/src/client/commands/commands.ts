/**
 * Command registry — all TUI commands as named, dispatchable units.
 *
 * Matches the Command + Registry pattern from Scribe (service/ops.go).
 * The colon prefix is the TUI invoker convention, not part of the command.
 * Any other invoker (MCP, HTTP) can dispatch through registry.find(name).
 */

import { buildModel, resolveProfile } from "@dpopsuev/alef-agent/model";
import { getModels, getProviders } from "@dpopsuev/alef-ai/models";
import type { Session } from "@dpopsuev/alef-session/contracts";
import type { SessionStore } from "@dpopsuev/alef-session/storage";
import { type SelectItem, SelectList, type SelectListTheme, type SettingItem, SettingsList } from "@dpopsuev/alef-tui";
import type { ChatLog, TuiStateStore } from "@dpopsuev/alef-tui/views";
import { getStoredApiKey, removeStoredApiKey, setStoredApiKey } from "../../boot/auth.js";
import { getConfig } from "../../boot/config.js";
import type { InteractiveOptions } from "../../boot/interactive.js";
import type { TuiEvent } from "../events.js";
import { color, getProviderColor, setThemeByName, statusGlyph, type ThemeTokens } from "../theme.js";

export interface TuiHandlerContext {
	tuiStore?: TuiStateStore;
	t: ThemeTokens;
	writer: ChatLog;
	opts?: InteractiveOptions;
	tui: {
		stop(): void;
		removeChild(c: unknown): void;
		addChild(c: unknown): void;
		requestRender(force?: boolean): void;
	};
	session: Session;
	store?: SessionStore;
	dispatch: (event: TuiEvent) => void;
	abortCurrentTurn: (() => void) | undefined;
	setAbortCurrentTurn(fn: (() => void) | undefined): void;
}

export interface Command {
	name: string;
	description: string;
	run(ctx: TuiHandlerContext, args: string[]): void | Promise<void>;
}

export class CommandRegistry {
	private readonly _commands = new Map<string, Command>();

	register(cmd: Command, ...aliases: string[]): this {
		this._commands.set(cmd.name, cmd);
		for (const alias of aliases) this._commands.set(alias, cmd);
		return this;
	}

	find(name: string): Command | undefined {
		return this._commands.get(name);
	}

	list(): ReadonlyArray<Command> {
		return [...new Set(this._commands.values())];
	}
}

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

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

function buildModelSubmenu(currentValue: string, done: (value?: string) => void, ctx: TuiHandlerContext) {
	const items = buildModelItems().map((item) => ({
		...item,
		label: currentValue.includes(item.value.split("/").pop() ?? "") ? `${item.label} *` : item.label,
	}));
	const theme = buildPickerTheme(ctx.t);
	const list = new SelectList(items, 12, theme).enableSearch();
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

function openModelPicker(ctx: TuiHandlerContext): void {
	const settingsItems: SettingItem[] = [
		{
			id: "model",
			label: "Model",
			currentValue: ctx.session.getModel(),
			description: "LLM model for this session. Enter to browse.",
			submenu: (currentValue, done) => buildModelSubmenu(currentValue, done, ctx),
		},
		{
			id: "thinking",
			label: "Thinking",
			currentValue: ctx.session.getThinking(),
			values: [...THINKING_LEVELS],
			description: "Extended thinking depth. Space/Enter to cycle.",
		},
	];

	const settingsTheme = {
		label: (s: string, sel: boolean) => (sel ? color(s, ctx.t.accentFg) : s),
		value: (s: string, sel: boolean) => (sel ? color(s, ctx.t.accentFg) : color(s, ctx.t.mutedFg)),
		description: (s: string) => color(s, ctx.t.mutedFg),
		cursor: color("→ ", ctx.t.accentFg),
		hint: (s: string) => color(s, ctx.t.mutedFg),
	};

	const close = () => {
		ctx.dispatch({ type: "overlay.hide", id: "model-picker" });
		ctx.tui.requestRender();
	};

	const settings = new SettingsList(
		settingsItems,
		10,
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
		descriptor: { id: "model-picker", component: settings, handleInput: (d: string) => settings.handleInput(d) },
	});
}

// ---------------------------------------------------------------------------
// Helper — fire-and-forget async with notice on error
// ---------------------------------------------------------------------------

function attempt(ctx: TuiHandlerContext, work: () => Promise<void>): void {
	work().catch((e: unknown) => {
		ctx.writer.addNotice(`Error: ${e instanceof Error ? e.message : String(e)}`);
		ctx.tui.requestRender();
	});
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const exit = {
	name: "q",
	description: "Quit",
	run(ctx: TuiHandlerContext) {
		ctx.session.dispose();
		ctx.tui.stop();
	},
};

const detach = {
	name: "detach",
	description: "Detach from daemon (leave it running)",
	run(ctx: TuiHandlerContext) {
		ctx.writer.addNotice("(detached — daemon keeps running)");
		ctx.tui.requestRender(true);
		ctx.session.dispose();
		ctx.tui.stop();
	},
};

const clear = {
	name: "new",
	description: "Clear conversation",
	run(ctx: TuiHandlerContext) {
		ctx.writer.clearAll();
		ctx.writer.addNotice("(conversation cleared)");
		ctx.tui.requestRender(true);
	},
};

const session = {
	name: "session",
	description: "Show session info + resume command",
	run(ctx: TuiHandlerContext) {
		ctx.writer.addNotice(
			`session: ${ctx.session.state.id}\n` +
				`model: ${ctx.session.state.modelId}\n` +
				`To resume: alef --resume ${ctx.session.state.id}`,
		);
		ctx.tui.requestRender();
	},
};

const help = {
	name: "help",
	description: "Show help",
	run(ctx: TuiHandlerContext) {
		const COMMAND_NAME_COL_WIDTH = 22;
		const lines = [...registry.list()]
			.map((c) => `  :${c.name.padEnd(COMMAND_NAME_COL_WIDTH)} ${c.description}`)
			.join("\n");
		ctx.writer.addNotice(`Commands:\n${lines}`);
		ctx.tui.requestRender();
	},
};

const login = {
	name: "login",
	description: "Save API key — :login <provider> <key>",
	run(ctx: TuiHandlerContext, args: string[]) {
		const [provider, ...rest] = args;
		const key = rest.join(" ").trim();
		if (!provider || !key) {
			const known = getProviders().slice(0, 8).join(", ");
			ctx.writer.addNotice(`Usage: :login <provider> <api-key>\nKnown providers: ${known}`);
		} else {
			void setStoredApiKey(provider, key);
			ctx.writer.addNotice(`Saved API key for ${provider}. Takes effect on the next message.`);
		}
		ctx.tui.requestRender();
	},
};

const logout = {
	name: "logout",
	description: "Remove stored API key — :logout <provider>",
	run(ctx: TuiHandlerContext, args: string[]) {
		const [provider] = args;
		if (!provider) {
			ctx.writer.addNotice("Usage: :logout <provider>");
		} else if (!getStoredApiKey(provider)) {
			ctx.writer.addNotice(`No stored key for ${provider}.`);
		} else {
			void removeStoredApiKey(provider);
			ctx.writer.addNotice(`Removed stored key for ${provider}.`);
		}
		ctx.tui.requestRender();
	},
};

const reload = {
	name: "reload",
	description: "Hot-reload an adapter — :reload <name> <path>",
	run(ctx: TuiHandlerContext, args: string[]) {
		const [name, path] = args;
		if (!name || !path) {
			ctx.writer.addNotice("Usage: :reload <name> <path>");
			ctx.tui.requestRender();
			return;
		}
		if (!ctx.session.reloadAdapter) {
			ctx.writer.addNotice(":reload not available in this session.");
			ctx.tui.requestRender();
			return;
		}
		ctx.writer.addNotice(`Reloading ${name}…`);
		ctx.tui.requestRender();
		attempt(ctx, async () => {
			await ctx.session.reloadAdapter?.(name, path);
			ctx.writer.addNotice(`Reloaded ${name}.`);
			ctx.tui.requestRender();
		});
	},
};

const load = {
	name: "load",
	description: "Mount a new adapter from a TypeScript file — :load <path>",
	run(ctx: TuiHandlerContext, args: string[]) {
		const [path] = args;
		if (!path) {
			ctx.writer.addNotice("Usage: :load <path>");
			ctx.tui.requestRender();
			return;
		}
		if (!ctx.session.loadAdapter) {
			ctx.writer.addNotice(":load not available in this session.");
			ctx.tui.requestRender();
			return;
		}
		ctx.writer.addNotice(`Loading ${path}…`);
		ctx.tui.requestRender();
		attempt(ctx, async () => {
			await ctx.session.loadAdapter?.(path);
			ctx.writer.addNotice(`Loaded ${path}.`);
			ctx.tui.requestRender();
		});
	},
};

const unload = {
	name: "unload",
	description: "Unmount a loaded adapter — :unload or :unload <name>",
	run(ctx: TuiHandlerContext, args: string[]) {
		if (!ctx.session.unloadAdapter) {
			ctx.writer.addNotice(":unload not available in this session.");
			ctx.tui.requestRender();
			return;
		}
		const [name] = args;
		if (name) {
			const removed = ctx.session.unloadAdapter(name);
			ctx.writer.addNotice(removed ? `Unloaded ${name}.` : `No adapter named '${name}'.`);
			ctx.tui.requestRender();
			return;
		}
		const adapters = ctx.session.adapters ?? [];
		if (adapters.length === 0) {
			ctx.writer.addNotice("No adapters loaded.");
			ctx.tui.requestRender();
			return;
		}
		openConfigPicker(ctx.t, ctx.dispatch, () => ctx.tui.requestRender(), {
			id: "unload-picker",
			source: () => [...(ctx.session.adapters ?? [])],
			toItem: (o) => ({ value: o.name, label: o.name, description: o.description }),
			onSelect: (o) => {
				const removed = ctx.session.unloadAdapter?.(o.name);
				ctx.writer.addNotice(removed ? `Unloaded ${o.name}.` : `No adapter named '${o.name}'.`);
				ctx.tui.requestRender();
			},
		});
	},
};

const install = {
	name: "install",
	description: "Install an adapter — install <adapter>[@version]",
	run(ctx: TuiHandlerContext, args: string[]) {
		const [spec] = args;
		if (!spec) {
			ctx.writer.addNotice("Usage: install <adapter>[@version]");
			ctx.tui.requestRender();
			return;
		}
		ctx.writer.addNotice(`Installing ${spec}…`);
		ctx.tui.requestRender();
		attempt(ctx, async () => {
			const pm = await import("../../pkg/alef-pm.js");
			pm.init();
			const [name, version] = spec.split("@");
			const { generation } = await pm.install(name, version);
			ctx.writer.addNotice(`Installed ${spec} (generation ${generation})`);
			ctx.tui.requestRender();
		});
	},
};

const upgrade = {
	name: "upgrade",
	description: "Upgrade all installed adapters",
	run(ctx: TuiHandlerContext) {
		ctx.writer.addNotice("Upgrading adapters…");
		ctx.tui.requestRender();
		attempt(ctx, async () => {
			const pm = await import("../../pkg/alef-pm.js");
			pm.init();
			const gen = await pm.upgrade();
			ctx.writer.addNotice(`Adapters upgraded (generation ${gen})`);
			ctx.tui.requestRender();
		});
	},
};

const rollback = {
	name: "rollback",
	description: "Roll back to a previous adapter generation — :rollback [N]",
	run(ctx: TuiHandlerContext, args: string[]) {
		attempt(ctx, async () => {
			const pm = await import("../../pkg/alef-pm.js");
			pm.init();
			const entries = pm.history();
			const n = args[0] ? parseInt(args[0], 10) : (entries[1]?.id ?? 1);
			await pm.rollback(n);
			ctx.writer.addNotice(`Rolled back to generation ${n}. Restart Alef to load the restored adapters.`);
			ctx.tui.requestRender();
		});
	},
};

const meta = {
	name: "meta",
	description: "Ask the Alef meta-agent — :meta <prompt>",
	run(ctx: TuiHandlerContext, args: string[]) {
		const prompt = args.join(" ").trim();
		if (!prompt) {
			ctx.writer.addNotice("Usage: :meta <free text prompt>\nExample: :meta list my sessions from last week");
			ctx.tui.requestRender();
			return;
		}
		ctx.writer.addUserMessage(`[meta] ${prompt}`);
		ctx.writer.addNotice("[meta] \u2508");
		ctx.tui.requestRender();
		attempt(ctx, async () => {
			const m = await import("@dpopsuev/alef-agent/meta-agent");
			let accumulated = "";
			const reply = await m.runMetaAgent(
				prompt,
				ctx.session.getModel(),
				(chunk) => {
					accumulated += chunk;
					ctx.writer.addNotice(`[meta] ${accumulated}`);
					ctx.tui.requestRender();
				},
				ctx.session.getDirective,
			);
			if (!accumulated && reply) {
				ctx.writer.addNotice(`[meta] ${reply}`);
				ctx.tui.requestRender();
			}
		});
	},
};

const directive = {
	name: "directive",
	description: "Manage system prompt blocks — :directive or :directive enable|disable|toggle <id>",
	run(ctx: TuiHandlerContext, args: string[]) {
		const scroll = ctx.session.getDirective?.();
		if (!scroll) {
			ctx.writer.addNotice(":directive not available in this session.");
			ctx.tui.requestRender();
			return;
		}
		const [sub, id] = args;
		if (sub === "enable" && id) {
			scroll.enable(id);
			ctx.writer.addNotice(`Block '${id}' enabled.`);
			ctx.tui.requestRender();
			return;
		}
		if (sub === "disable" && id) {
			scroll.disable(id);
			ctx.writer.addNotice(`Block '${id}' disabled.`);
			ctx.tui.requestRender();
			return;
		}
		if (sub === "toggle" && id) {
			scroll.toggle(id);
			ctx.writer.addNotice(`Toggled block '${id}'.`);
			ctx.tui.requestRender();
			return;
		}
		openConfigPicker(ctx.t, ctx.dispatch, () => ctx.tui.requestRender(), {
			id: "directive-picker",
			source: () => scroll.list(),
			toItem: (b) => ({
				value: b.id,
				label: `${b.enabled ? statusGlyph("active") : statusGlyph("pending")} ${b.id}`,
				description: b.tags?.join(", "),
			}),
			onSelect: (b) => {
				scroll.toggle(b.id);
				const updated = scroll.list().find((x) => x.id === b.id);
				ctx.writer.addNotice(
					`${updated?.enabled ? statusGlyph("active") : statusGlyph("pending")} Block '${b.id}' toggled.`,
				);
				ctx.tui.requestRender();
			},
		});
	},
};

const THEMES = ["terminal", "terminal-light", "akko", "mono", "matrix"] as const;

const theme = {
	name: "theme",
	description: "Switch theme — :theme or :theme <name>",
	run(ctx: TuiHandlerContext, args: string[]) {
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

const model = {
	name: "model",
	description: "Switch model — :model or :model <id>",
	run(ctx: TuiHandlerContext, args: string[]) {
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

const think = {
	name: "think",
	description: "Set thinking level — :think or :think <level>",
	run(ctx: TuiHandlerContext, args: string[]) {
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

const profile = {
	name: "profile",
	description: "Switch model profile — :profile or :profile <name>",
	run(ctx: TuiHandlerContext, args: string[]) {
		const cfg = getConfig();
		const names = cfg.profiles ? Object.keys(cfg.profiles) : [];
		if (names.length === 0) {
			ctx.writer.addNotice("No profiles defined in config.yaml.");
			ctx.tui.requestRender();
			return;
		}

		const [name] = args;
		if (name) {
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
					// default model not valid — ignore
				}
			}
			ctx.writer.addNotice(
				`Profile "${name}" active — ${count} models.${defaultModel ? ` Default: ${defaultModel}` : ""}`,
			);
			ctx.tui.requestRender();
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
				profile.run(ctx, [item.value]);
			},
		});
	},
};

const skills = {
	name: "skills",
	description: "Browse and invoke skills — :skills or :skills <name>",
	async run(ctx: TuiHandlerContext, args: string[]) {
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

// ---------------------------------------------------------------------------
// :sticky — attach a timestamped note linked to recent events
// ---------------------------------------------------------------------------

const sticky = {
	name: "sticky",
	description: "Attach a note to the session timeline (linked to recent events)",
	async run(ctx: TuiHandlerContext, args: string[]) {
		const text = args.join(" ").trim();
		if (!text) {
			ctx.writer.addNotice("Usage: :sticky <note text>");
			ctx.tui.requestRender();
			return;
		}
		if (!ctx.store) return;

		const allEvents = await ctx.store.events();
		const nearbyEvents = allEvents
			.filter((e) => e.bus === "command" || e.bus === "event")
			.slice(-5)
			.map((e) => ({ type: e.type, correlationId: e.correlationId, timestamp: e.timestamp }));

		await ctx.store.append({
			bus: "internal",
			type: "user.sticky",
			correlationId: "sticky",
			payload: { text, nearbyEvents },
			timestamp: Date.now(),
			actor: { address: ctx.opts?.humanAddress ?? "@you", type: "human" },
		});

		ctx.writer.addNotice(`\u{1F4CC} ${text}`);
		ctx.tui.requestRender();
	},
};

const stickies = {
	name: "stickies",
	description: "List all sticky notes in this session",
	async run(ctx: TuiHandlerContext) {
		if (!ctx.store) return;
		const all = await ctx.store.events();
		const notes = all.filter((e) => e.type === "user.sticky");
		if (notes.length === 0) {
			ctx.writer.addNotice("No sticky notes in this session.");
		} else {
			for (const s of notes) {
				const p = s.payload as { text?: string };
				const time = new Date(s.timestamp).toLocaleTimeString();
				ctx.writer.addNotice(`[${time}] ${p.text ?? ""}`);
			}
		}
		ctx.tui.requestRender();
	},
};

// ---------------------------------------------------------------------------
// Registry — single source of truth; tab-completion and help derive from this
// ---------------------------------------------------------------------------

export const registry = new CommandRegistry()
	.register(exit, "quit", "exit")
	.register(detach)
	.register(clear, "clear")
	.register(session)
	.register(help, "h")
	.register(login)
	.register(logout)
	.register(reload)
	.register(load)
	.register(unload)
	.register(install)
	.register(upgrade)
	.register(rollback)
	.register(meta)
	.register(directive)
	.register(theme)
	.register(model)
	.register(think)
	.register(profile)
	.register(skills)
	.register(sticky, "note", "pin")
	.register(stickies);

export interface ConfigPickerOptions<T> {
	id: string;
	source: () => readonly T[];
	toItem: (entry: T) => SelectItem;
	onSelect: (entry: T) => void;
	maxVisible?: number;
}

export function openConfigPicker<T>(
	t: ThemeTokens,
	dispatch: (event: TuiEvent) => void,
	requestRender: () => void,
	opts: ConfigPickerOptions<T>,
): void {
	const entries = opts.source();
	const entryMap = new Map<string, T>();
	const items: SelectItem[] = entries.map((entry) => {
		const item = opts.toItem(entry);
		entryMap.set(item.value, entry);
		return item;
	});

	openPicker(t, dispatch, requestRender, {
		id: opts.id,
		items,
		maxVisible: opts.maxVisible,
		onSelect: (item) => {
			const entry = entryMap.get(item.value);
			if (entry) opts.onSelect(entry);
		},
	});
}

export interface EnumPickerOptions {
	id: string;
	values: readonly string[];
	active?: string;
	onSelect: (value: string) => void;
	maxVisible?: number;
}

export function openEnumPicker(
	t: ThemeTokens,
	dispatch: (event: TuiEvent) => void,
	requestRender: () => void,
	opts: EnumPickerOptions,
): void {
	const items: SelectItem[] = opts.values.map((v) => ({
		value: v,
		label: v === opts.active ? `${v} *` : v,
	}));

	openPicker(t, dispatch, requestRender, {
		id: opts.id,
		items,
		maxVisible: opts.maxVisible ?? opts.values.length,
		onSelect: (item) => opts.onSelect(item.value),
	});
}

export interface PickerOptions {
	id: string;
	items: SelectItem[];
	maxVisible?: number;
	onSelect: (item: SelectItem) => void;
}

export function buildPickerTheme(t: ThemeTokens): SelectListTheme {
	return {
		selectedPrefix: (s) => color(s, t.accentFg),
		selectedText: (s) => color(s, t.accentFg),
		description: (s) => color(s, t.mutedFg),
		scrollInfo: (s) => color(s, t.mutedFg),
		noMatch: (s) => color(s, t.mutedFg),
	};
}

export function openPicker(
	t: ThemeTokens,
	dispatch: (event: TuiEvent) => void,
	requestRender: () => void,
	opts: PickerOptions,
): void {
	const theme = buildPickerTheme(t);
	const list = new SelectList(opts.items, opts.maxVisible ?? 10, theme).enableSearch();

	const close = () => {
		dispatch({ type: "overlay.hide", id: opts.id });
		requestRender();
	};

	list.onSelect = (item: SelectItem) => {
		close();
		opts.onSelect(item);
	};
	list.onCancel = close;

	dispatch({
		type: "overlay.show",
		descriptor: { id: opts.id, component: list, handleInput: (d) => list.handleInput(d) },
	});
}
