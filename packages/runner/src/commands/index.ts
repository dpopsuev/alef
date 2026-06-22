/**
 * Command registry — all TUI commands as named, dispatchable units.
 *
 * Matches the Command + Registry pattern from Scribe (service/ops.go).
 * The colon prefix is the TUI invoker convention, not part of the command.
 * Any other invoker (MCP, HTTP) can dispatch through registry.find(name).
 */

import { getModels, getProviders, type KnownProvider } from "@dpopsuev/alef-llm";
import type { SelectItem } from "@dpopsuev/alef-tui";
import { getStoredApiKey, removeStoredApiKey, setStoredApiKey } from "../auth.js";
import { getConfig } from "../config.js";
import { buildModel } from "../model.js";
import { resolveProfile } from "../model-profiles.js";
import { getProviderColor } from "../provider-colors.js";
import { color, setThemeByName } from "../theme.js";
import { openConfigPicker, openEnumPicker } from "../tui/config-picker.js";
import { openPicker } from "../tui/picker.js";
import { CommandRegistry } from "./registry.js";
import type { TuiHandlerContext } from "./types.js";

function isAnthropicViaVertex(): boolean {
	const projectId =
		process.env.ANTHROPIC_VERTEX_PROJECT_ID?.trim() ||
		process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
		process.env.GCLOUD_PROJECT?.trim();
	const region = process.env.CLOUD_ML_REGION?.trim() || process.env.GOOGLE_CLOUD_LOCATION?.trim();
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
		for (const m of getModels(provider as KnownProvider)) {
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

function openModelPicker(ctx: TuiHandlerContext): void {
	const current = ctx.session.getModel() ?? "";
	const items = buildModelItems().map((item) => ({
		...item,
		label: current.includes(item.value.split("/").pop() ?? "") ? `${item.label} *` : item.label,
	}));

	openPicker(ctx.t, ctx.dispatch, () => ctx.tui.requestRender(), {
		id: "model-picker",
		items,
		onSelect: (item) => {
			try {
				buildModel(item.value);
				ctx.session.setModel(item.value);
				ctx.writer.addNotice(`Model switched to ${item.value}.`);
			} catch (e) {
				ctx.writer.addNotice(`Failed: ${e instanceof Error ? e.message : String(e)}`);
			}
			ctx.tui.requestRender();
		},
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
		const lines = [...registry.list()].map((c) => `  :${c.name.padEnd(22)} ${c.description}`).join("\n");
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
			setStoredApiKey(provider, key);
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
			removeStoredApiKey(provider);
			ctx.writer.addNotice(`Removed stored key for ${provider}.`);
		}
		ctx.tui.requestRender();
	},
};

const reload = {
	name: "reload",
	description: "Hot-reload an organ — :reload <name> <path>",
	run(ctx: TuiHandlerContext, args: string[]) {
		const [name, path] = args;
		if (!name || !path) {
			ctx.writer.addNotice("Usage: :reload <name> <path>");
			ctx.tui.requestRender();
			return;
		}
		if (!ctx.session.reloadOrgan) {
			ctx.writer.addNotice(":reload not available in this session.");
			ctx.tui.requestRender();
			return;
		}
		ctx.writer.addNotice(`Reloading ${name}…`);
		ctx.tui.requestRender();
		attempt(ctx, async () => {
			await ctx.session.reloadOrgan?.(name, path);
			ctx.writer.addNotice(`Reloaded ${name}.`);
			ctx.tui.requestRender();
		});
	},
};

const load = {
	name: "load",
	description: "Mount a new organ from a TypeScript file — :load <path>",
	run(ctx: TuiHandlerContext, args: string[]) {
		const [path] = args;
		if (!path) {
			ctx.writer.addNotice("Usage: :load <path>");
			ctx.tui.requestRender();
			return;
		}
		if (!ctx.session.loadOrgan) {
			ctx.writer.addNotice(":load not available in this session.");
			ctx.tui.requestRender();
			return;
		}
		ctx.writer.addNotice(`Loading ${path}…`);
		ctx.tui.requestRender();
		attempt(ctx, async () => {
			await ctx.session.loadOrgan?.(path);
			ctx.writer.addNotice(`Loaded ${path}.`);
			ctx.tui.requestRender();
		});
	},
};

const unload = {
	name: "unload",
	description: "Unmount a loaded organ — :unload or :unload <name>",
	run(ctx: TuiHandlerContext, args: string[]) {
		if (!ctx.session.unloadOrgan) {
			ctx.writer.addNotice(":unload not available in this session.");
			ctx.tui.requestRender();
			return;
		}
		const [name] = args;
		if (name) {
			const removed = ctx.session.unloadOrgan(name);
			ctx.writer.addNotice(removed ? `Unloaded ${name}.` : `No organ named '${name}'.`);
			ctx.tui.requestRender();
			return;
		}
		const organs = ctx.session.organs ?? [];
		if (organs.length === 0) {
			ctx.writer.addNotice("No organs loaded.");
			ctx.tui.requestRender();
			return;
		}
		openConfigPicker(ctx.t, ctx.dispatch, () => ctx.tui.requestRender(), {
			id: "unload-picker",
			source: () => [...(ctx.session.organs ?? [])],
			toItem: (o) => ({ value: o.name, label: o.name, description: o.description }),
			onSelect: (o) => {
				const removed = ctx.session.unloadOrgan?.(o.name);
				ctx.writer.addNotice(removed ? `Unloaded ${o.name}.` : `No organ named '${o.name}'.`);
				ctx.tui.requestRender();
			},
		});
	},
};

const install = {
	name: "install",
	description: "Install an organ — :install <organ>[@version]",
	run(ctx: TuiHandlerContext, args: string[]) {
		const [spec] = args;
		if (!spec) {
			ctx.writer.addNotice("Usage: :install <organ>[@version]");
			ctx.tui.requestRender();
			return;
		}
		ctx.writer.addNotice(`Installing ${spec}…`);
		ctx.tui.requestRender();
		attempt(ctx, async () => {
			const pm = await import("../alef-pm.js");
			pm.init();
			const [name, version] = spec.split("@");
			const gen = await pm.install(name, version);
			ctx.writer.addNotice(`Installed ${spec} (generation ${gen})`);
			ctx.tui.requestRender();
		});
	},
};

const upgrade = {
	name: "upgrade",
	description: "Upgrade all installed organs",
	run(ctx: TuiHandlerContext) {
		ctx.writer.addNotice("Upgrading organs…");
		ctx.tui.requestRender();
		attempt(ctx, async () => {
			const pm = await import("../alef-pm.js");
			pm.init();
			const gen = await pm.upgrade();
			ctx.writer.addNotice(`Organs upgraded (generation ${gen})`);
			ctx.tui.requestRender();
		});
	},
};

const rollback = {
	name: "rollback",
	description: "Roll back to a previous organ generation — :rollback [N]",
	run(ctx: TuiHandlerContext, args: string[]) {
		attempt(ctx, async () => {
			const pm = await import("../alef-pm.js");
			pm.init();
			const entries = pm.history();
			const n = args[0] ? parseInt(args[0], 10) : (entries[1]?.id ?? 1);
			await pm.rollback(n);
			ctx.writer.addNotice(`Rolled back to generation ${n}. Restart Alef to load the restored organs.`);
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
			const m = await import("../meta-agent.js");
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
				label: `${b.enabled ? "●" : "○"} ${b.id}`,
				description: b.tags?.join(", "),
			}),
			onSelect: (b) => {
				scroll.toggle(b.id);
				const updated = scroll.list().find((x) => x.id === b.id);
				ctx.writer.addNotice(`${updated?.enabled ? "●" : "○"} Block '${b.id}' toggled.`);
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
			if (!THEMES.includes(name as (typeof THEMES)[number])) {
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

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

const think = {
	name: "think",
	description: "Set thinking level — :think or :think <level>",
	run(ctx: TuiHandlerContext, args: string[]) {
		const [level] = args;
		if (level) {
			if (!THINKING_LEVELS.includes(level as (typeof THINKING_LEVELS)[number])) {
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
			active: ctx.session.getThinking() ?? "off",
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
				description: p ? `${p.providers.join(", ")}${p.default ? ` → ${p.default}` : ""}` : "",
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

// ---------------------------------------------------------------------------
// Registry — single source of truth; tab-completion and help derive from this
// ---------------------------------------------------------------------------

export const registry = new CommandRegistry()
	.register(exit, "quit", "exit")
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
	.register(profile);
