import { openConfigPicker } from "./overlay-picker.js";
import { type AdapterCmdCtx, attempt, type Command } from "./types.js";

export const reload: Command = {
	name: "reload",
	description: "Reload an adapter in-place — :reload <name> <path>",
	run(ctx: AdapterCmdCtx, args: string[]) {
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

export const load: Command = {
	name: "load",
	description: "Mount a new adapter from a TypeScript file — :load <path>",
	run(ctx: AdapterCmdCtx, args: string[]) {
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

export const unload: Command = {
	name: "unload",
	description: "Unmount a loaded adapter — :unload or :unload <name>",
	run(ctx: AdapterCmdCtx, args: string[]) {
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

export const install: Command = {
	name: "install",
	description: "Install an adapter — install <adapter>[@version]",
	run(ctx: AdapterCmdCtx, args: string[]) {
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
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- split always returns at least one element; destructuring covers the two-element case
			const [name, version] = spec.split("@") as [string, string | undefined];
			const { generation } = await pm.install(name, version);
			ctx.writer.addNotice(`Installed ${spec} (generation ${generation})`);
			ctx.tui.requestRender();
		});
	},
};

export const upgrade: Command = {
	name: "upgrade",
	description: "Upgrade all installed adapters",
	run(ctx: AdapterCmdCtx) {
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

export const rollback: Command = {
	name: "rollback",
	description: "Roll back to a previous adapter generation — :rollback [N]",
	run(ctx: AdapterCmdCtx, args: string[]) {
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
