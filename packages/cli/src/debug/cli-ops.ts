import { resolveProfile } from "@dpopsuev/alef-agent/model";
import { createDefaultDirectives } from "@dpopsuev/alef-agent/prompt";
import { getModels, getProviders } from "@dpopsuev/alef-ai/models";
import type { Args } from "../boot/args.js";
import { getConfig } from "../boot/config.js";
import type { SessionHandle } from "../boot/session.js";
import { loadWorkspace } from "../boot/workspace.js";

interface CliOp {
	name: string;
	match: (args: Args) => boolean;
	run: (args: Args, session: SessionHandle) => Promise<void> | void;
}

const ops: CliOp[] = [];

function register(op: CliOp): void {
	ops.push(op);
}

export function dispatchCliOp(args: Args, session: SessionHandle): boolean {
	for (const op of ops) {
		if (op.match(args)) {
			const result = op.run(args, session);
			if (result instanceof Promise) {
				result
					.then(() => process.exit(0))
					.catch((e: unknown) => {
						console.error(e instanceof Error ? e.message : String(e));
						process.exit(1);
					});
			} else {
				process.exit(0);
			}
			return true;
		}
	}
	return false;
}

register({
	name: "list-tools",
	match: (args) => args.listTools,
	run: (_args, session) => {
		for (const tool of session.tools) console.log(tool.name);
	},
});

register({
	name: "list-adapters",
	match: (args) => args.listAdapters,
	run: (_args, session) => {
		for (const adapter of session.adapters) {
			const suffix = [
				adapter.labels?.length ? `[${adapter.labels.join(", ")}]` : "",
				adapter.description ? `— ${adapter.description}` : "",
			]
				.filter(Boolean)
				.join(" ");
			console.log(suffix ? `${adapter.name} ${suffix}` : adapter.name);
		}
	},
});

register({
	name: "list-models",
	match: (args) => args.listModels,
	run: () => {
		const cfg = getConfig();
		const profile = resolveProfile(cfg);
		const current = cfg.model ?? "";

		if (profile) {
			console.log(`Profile: ${profile.name}`);
			for (const entry of profile.models) {
				const marker = current.includes(entry.model.id) ? " *" : "";
				console.log(`  ${entry.provider}/${entry.model.id}${marker}  ${entry.model.name}`);
			}
			return;
		}

		for (const provider of getProviders()) {
			for (const m of getModels(provider)) {
				const marker = current.includes(m.id) ? " *" : "";
				console.log(`${provider}/${m.id}${marker}  ${m.name}`);
			}
		}
	},
});

register({
	name: "show-config",
	match: (args) => args.showConfig,
	run: () => {
		const cfg = getConfig();
		console.log(JSON.stringify(cfg, null, 2));
	},
});

register({
	name: "list-directives",
	match: (args) => args.listDirectives,
	run: async (args) => {
		const directives = createDefaultDirectives({ tools: [], cwd: args.cwd });
		await loadWorkspace(directives, args.cwd);
		const blocks = directives.list({ enabled: true });
		for (const b of blocks) {
			const tags = b.tags?.length ? ` (${b.tags.join(", ")})` : "";
			console.log(`[${b.priority}] ${b.id}${tags}`);
		}
	},
});

register({
	name: "preflight",
	match: (args) => args.preflight,
	run: async (args, session) => {
		const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

		const cfg = getConfig();
		checks.push({ name: "config", ok: true, detail: "parsed" });

		const profile = resolveProfile(cfg);
		checks.push({ name: "profile", ok: true, detail: profile ? profile.name : "(none)" });

		const model = session.getModel();
		checks.push({ name: "model", ok: !!model, detail: model || "not resolved" });

		const adapters = session.adapters;
		checks.push({ name: "adapters", ok: adapters.length > 0, detail: `${adapters.length} loaded` });

		const tools = session.tools;
		checks.push({ name: "tools", ok: tools.length > 0, detail: `${tools.length} available` });

		const directives = createDefaultDirectives({ tools, cwd: args.cwd });
		await loadWorkspace(directives, args.cwd);
		const blocks = directives.list({ enabled: true });
		const hasEmoji = blocks.some((b) => b.id === "no-emojis");
		const hasFiles = blocks.some((b) => b.id === "no-files");
		checks.push({
			name: "directives",
			ok: true,
			detail: `${blocks.length} blocks (no-emojis: ${hasEmoji}, no-files: ${hasFiles})`,
		});

		let allOk = true;
		for (const c of checks) {
			const icon = c.ok ? "ok" : "FAIL";
			console.log(`  [${icon}] ${c.name}: ${c.detail}`);
			if (!c.ok) allOk = false;
		}
		if (!allOk) process.exit(1);
	},
});
