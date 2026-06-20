/**
 * Command registry — all TUI commands as named, dispatchable units.
 *
 * Matches the Command + Registry pattern from Scribe (service/ops.go).
 * The colon prefix is the TUI invoker convention, not part of the command.
 * Any other invoker (MCP, HTTP) can dispatch through registry.find(name).
 */

import { getModels, getProviders, type KnownProvider } from "@dpopsuev/alef-llm";
import { getStoredApiKey, removeStoredApiKey, setStoredApiKey } from "../auth.js";
import { buildModel } from "../model.js";
import { setThemeByName } from "../theme.js";
import { CommandRegistry } from "./registry.js";
import type { TuiHandlerContext } from "./types.js";

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
	description: "Unmount a loaded organ by name — :unload <name>",
	run(ctx: TuiHandlerContext, args: string[]) {
		const [name] = args;
		if (!name) {
			ctx.writer.addNotice("Usage: :unload <name>");
			ctx.tui.requestRender();
			return;
		}
		if (!ctx.session.unloadOrgan) {
			ctx.writer.addNotice(":unload not available in this session.");
			ctx.tui.requestRender();
			return;
		}
		const removed = ctx.session.unloadOrgan?.(name);
		ctx.writer.addNotice(removed ? `Unloaded ${name}.` : `No organ named '${name}'.`);
		ctx.tui.requestRender();
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
	description: "Manage system prompt blocks — :directive list | enable | disable | toggle <id>",
	run(ctx: TuiHandlerContext, args: string[]) {
		const scroll = ctx.session.getDirective?.();
		if (!scroll) {
			ctx.writer.addNotice(":directive not available in this session.");
			ctx.tui.requestRender();
			return;
		}
		const [sub = "", id] = args;
		switch (sub.toLowerCase()) {
			case "list":
			case "": {
				const lines = scroll
					.list()
					.map(
						(b) =>
							`  [${b.priority}] ${b.enabled ? "●" : "○"} ${b.id}${b.tags?.length ? ` (${b.tags.join(", ")})` : ""}`,
					);
				ctx.writer.addNotice(`Prompt blocks:\n${lines.join("\n")}`);
				break;
			}
			case "enable":
				if (!id) {
					ctx.writer.addNotice("Usage: :directive enable <id>");
					break;
				}
				scroll.enable(id);
				ctx.writer.addNotice(`● Block '${id}' enabled. Takes effect next turn.`);
				break;
			case "disable":
				if (!id) {
					ctx.writer.addNotice("Usage: :directive disable <id>");
					break;
				}
				scroll.disable(id);
				ctx.writer.addNotice(`○ Block '${id}' disabled. Takes effect next turn.`);
				break;
			case "toggle":
				if (!id) {
					ctx.writer.addNotice("Usage: :directive toggle <id>");
					break;
				}
				scroll.toggle(id);
				ctx.writer.addNotice(`Toggled block '${id}'. Takes effect next turn.`);
				break;
			default:
				ctx.writer.addNotice("Usage: :directive list | enable <id> | disable <id> | toggle <id>");
		}
		ctx.tui.requestRender();
	},
};

const theme = {
	name: "theme",
	description: "Switch theme — :theme <name>",
	run(ctx: TuiHandlerContext, args: string[]) {
		const THEMES = ["terminal", "terminal-light", "akko", "mono", "matrix"];
		const name = args[0]?.toLowerCase();
		if (!name) {
			ctx.writer.addNotice(`Available themes: ${THEMES.join("  ")}\nUsage: :theme <name>`);
		} else if (!THEMES.includes(name)) {
			ctx.writer.addNotice(`Unknown theme '${name}'. Available: ${THEMES.join(", ")}`);
		} else {
			setThemeByName(name);
			ctx.writer.addNotice(`Theme set to '${name}'.`);
			ctx.tui.requestRender(true);
			return;
		}
		ctx.tui.requestRender();
	},
};

const model = {
	name: "model",
	description: "Switch model — :model or :model <id>",
	run(ctx: TuiHandlerContext, args: string[]) {
		const [newId] = args;
		if (newId) {
			try {
				const built = buildModel(newId);
				ctx.session.setModel(newId);
				ctx.writer.addNotice(`Model switched to ${built.id}. Takes effect on the next message.`);
			} catch (e) {
				ctx.writer.addNotice(`Unknown model: ${newId}. ${e instanceof Error ? e.message : ""}`);
			}
			ctx.tui.requestRender();
			return;
		}
		const current = ctx.session.getModel() ?? "";
		const lines: string[] = [];
		for (const provider of getProviders()) {
			for (const m of getModels(provider as KnownProvider)) {
				const id = `${provider}/${m.id}`;
				const marker = current.includes(m.id) ? " *" : "";
				lines.push(`  ${id}${marker}`);
			}
		}
		ctx.writer.addNotice(`Models (* = active):\n${lines.join("\n")}\n\nUsage: :model <provider/id>`);
		ctx.tui.requestRender();
	},
};

const think = {
	name: "think",
	description: "Set thinking level — :think off | minimal | low | medium | high | xhigh",
	run(ctx: TuiHandlerContext, args: string[]) {
		const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
		const [level] = args;
		if (!level) {
			const current = ctx.session.getThinking() ?? "off";
			ctx.writer.addNotice(`Thinking: ${current}\nUsage: :think <level>  (${LEVELS.join(" | ")})`);
			ctx.tui.requestRender();
			return;
		}
		if (!LEVELS.includes(level as (typeof LEVELS)[number])) {
			ctx.writer.addNotice(`Unknown level: ${level}. Valid: ${LEVELS.join(" | ")}`);
			ctx.tui.requestRender();
			return;
		}
		ctx.session.setThinking(level);
		ctx.writer.addNotice(`Thinking set to "${level}". Takes effect on the next message.`);
		ctx.tui.requestRender();
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
	.register(think);
