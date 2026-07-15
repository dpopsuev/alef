import { BUILD_INFO } from "../../boot/build-info.js";
import { parseCompactArgs, runManualCompact } from "./manual-compact.js";
import type { Command, LifecycleCmdCtx, TuiHandlerContext } from "./types.js";
import { attempt } from "./types.js";
import {
	createDefaultUpdateShell,
	defaultRespawn,
	parseUpdateArgs,
	resolveRebuild,
	runRestart,
	runUpdate,
} from "./update-service.js";

export { parseUpdateArgs } from "./update-service.js";

/** Spawn a resumed process then dispose the current session UI. */
async function respawnAndExit(ctx: LifecycleCmdCtx): Promise<void> {
	await defaultRespawn(ctx.session.state.id);
	await ctx.session.dispose();
	ctx.tui.stop();
	process.exit(0);
}

/**
 * Restart command: hot-reload in place when available, else respawn + resume.
 */
export const restart: Command = {
	name: "restart",
	description: "Restart Alef (in-place hot-reload when available)",
	run(ctx: LifecycleCmdCtx) {
		attempt(ctx, async () => {
			const rebuild = resolveRebuild();
			if (rebuild) {
				ctx.writer.addNotice("Hot-reloading session...");
				ctx.tui.requestRender(true);
			} else {
				ctx.writer.addNotice("Restarting...");
				ctx.tui.requestRender(true);
			}
			const result = await runRestart({
				rebuild,
				respawn: async () => {
					await respawnAndExit(ctx);
				},
			});
			if (result.kind === "reloaded") {
				ctx.writer.addNotice("Reload complete — session swapped in place.");
				ctx.tui.requestRender();
			}
		});
	},
};

export const update: Command = {
	name: "update",
	description: "Update Alef [:update [--force] [--check]]",
	run(ctx: LifecycleCmdCtx, args: string[]) {
		attempt(ctx, async () => {
			const { force, checkOnly } = parseUpdateArgs(args);
			const shell = createDefaultUpdateShell();

			if (BUILD_INFO.channel === "dev") {
				ctx.writer.addNotice(checkOnly ? "Checking git remote..." : "Updating from git...");
			} else {
				ctx.writer.addNotice("Checking for updates...");
			}
			ctx.tui.requestRender(true);

			if (force && BUILD_INFO.channel === "dev") {
				const dirty = shell.gitStatusPorcelain().trim();
				if (dirty) {
					ctx.writer.addNotice("Warning: dirty tree — proceeding with --force");
					ctx.tui.requestRender(true);
				}
			}

			const result = await runUpdate({
				channel: BUILD_INFO.channel,
				force,
				checkOnly,
				version: BUILD_INFO.version,
				shell,
				rebuild: resolveRebuild(),
				respawn: async () => {
					await respawnAndExit(ctx);
				},
			});

			switch (result.kind) {
				case "aborted-dirty":
					ctx.writer.addNotice("Update aborted: working tree is dirty. Commit/stash, or :update --force");
					break;
				case "check":
					ctx.writer.addNotice(result.detail);
					break;
				case "up-to-date":
					ctx.writer.addNotice("Already on latest version.");
					break;
				case "available":
					ctx.writer.addNotice(`Update available: ${BUILD_INFO.version} → ${result.release.version}`);
					ctx.writer.addNotice(`Changelog:\n${result.release.changelog}`);
					ctx.writer.addNotice(`\nTo apply: :update`);
					break;
				case "reloaded":
					ctx.writer.addNotice("Reload complete — session swapped in place.");
					break;
				case "respawn":
					// process already exiting
					break;
				case "failed":
					ctx.writer.addNotice(`Update failed: ${result.message}`);
					break;
			}
			ctx.tui.requestRender();
		});
	},
};

export const exit: Command = {
	name: "q",
	description: "Quit",
	run(ctx: LifecycleCmdCtx) {
		void ctx.session.dispose();
		ctx.tui.stop();
	},
};

export const detach: Command = {
	name: "detach",
	description: "Detach from daemon (leave it running)",
	run(ctx: LifecycleCmdCtx) {
		ctx.writer.addNotice("(detached — daemon keeps running)");
		ctx.tui.requestRender(true);
		void ctx.session.dispose();
		ctx.tui.stop();
	},
};

export const clear: Command = {
	name: "new",
	description: "Clear conversation",
	run(ctx: LifecycleCmdCtx) {
		ctx.writer.clearAll();
		ctx.writer.addNotice("(conversation cleared)");
		ctx.tui.requestRender(true);
	},
};

export const compact: Command = {
	name: "compact",
	description: "Compact context now [:compact [--strategy=shake|summarize] instructions]",
	run(ctx: TuiHandlerContext, args: string[]) {
		const { strategy, instructions } = parseCompactArgs(args);
		attempt(ctx, async () => {
			const store = ctx.store;
			if (!store) {
				ctx.writer.addNotice("(compaction unavailable — no session store)");
				ctx.tui.requestRender();
				return;
			}
			const summarize = ctx.session.summarizeForCompaction ?? ctx.opts?.summarize;
			if (!summarize && strategy === "summarize") {
				ctx.writer.addNotice("(compaction unavailable — no LLM summarizer)");
				ctx.tui.requestRender();
				return;
			}
			const { notice } = await runManualCompact({
				store,
				summarize: summarize ?? (() => ""),
				instructions,
				strategy,
			});
			ctx.writer.addNotice(notice);
			ctx.tui.requestRender();
		});
	},
};

export const session: Command = {
	name: "session",
	description: "Show session info + resume command",
	run(ctx: TuiHandlerContext) {
		const store = ctx.store;
		const name = store?.name();
		const tags = store?.tags() ?? [];
		const nameLine = name ? `name: ${name} (${store?.nameSource() ?? "?"})\n` : "";
		const tagsLine = tags.length > 0 ? `tags: ${tags.join(", ")}\n` : "";
		ctx.writer.addNotice(
			`session: ${ctx.session.state.id}\n` +
				nameLine +
				tagsLine +
				`model: ${ctx.session.state.modelId}\n` +
				`To resume: alef --resume ${ctx.session.state.id}`,
		);
		ctx.tui.requestRender();
	},
};

export const context: Command = {
	name: "context",
	description: "List last-turn context injections",
	run(ctx: TuiHandlerContext) {
		attempt(ctx, async () => {
			const store = ctx.store;
			if (!store) {
				ctx.writer.addNotice("(no session store)");
				ctx.tui.requestRender();
				return;
			}
			const events = await store.events();
			let lastInputIdx = -1;
			for (let i = events.length - 1; i >= 0; i--) {
				if (events[i]?.type === "llm.input") {
					lastInputIdx = i;
					break;
				}
			}
			const window = lastInputIdx >= 0 ? events.slice(lastInputIdx) : events.slice(-20);
			const injections = window.filter((event) => event.type === "context.injection");
			if (injections.length === 0) {
				ctx.writer.addNotice("(no context injections in last turn)");
				ctx.tui.requestRender();
				return;
			}
			const lines = injections.map((event) => {
				const source = typeof event.payload.source === "string" ? event.payload.source : "?";
				const chars = typeof event.payload.chars === "number" ? event.payload.chars : 0;
				const preview = typeof event.payload.preview === "string" ? event.payload.preview : "";
				return `  ${source} (+${chars}) ${preview}`.trimEnd();
			});
			ctx.writer.addNotice(`Context injections:\n${lines.join("\n")}`);
			ctx.tui.requestRender();
		});
	},
};

export const tokens: Command = {
	name: "tokens",
	description: "Show session token usage statistics",
	run(ctx: TuiHandlerContext) {
		const stats = ctx.sessionTokens;
		if (!stats) {
			ctx.writer.addNotice("(token stats unavailable)");
			ctx.tui.requestRender();
			return;
		}

		const { input, output, total, costUsd: cost, contextFill: context, contextWindow } = stats;

		const lines = [
			"Session token usage:",
			`  Input tokens:   ${input.toLocaleString()}`,
			`  Output tokens:  ${output.toLocaleString()}`,
			`  Total tokens:   ${total.toLocaleString()}`,
		];

		if (cost > 0) {
			lines.push(`  Cost (USD):     $${cost.toFixed(4)}`);
		}

		if (contextWindow > 0) {
			const fillPct = ((context / contextWindow) * 100).toFixed(1);
			lines.push("");
			lines.push("Context window:");
			lines.push(`  Used:           ${context.toLocaleString()} / ${contextWindow.toLocaleString()} (${fillPct}%)`);
		}

		if (total > 0) {
			const inputPct = ((input / total) * 100).toFixed(1);
			const outputPct = ((output / total) * 100).toFixed(1);
			lines.push("");
			lines.push("Composition:");
			lines.push(`  Input:          ${inputPct}%`);
			lines.push(`  Output:         ${outputPct}%`);
		}

		ctx.writer.addNotice(lines.join("\n"));
		ctx.tui.requestRender();
	},
};

/** Build the :help command against a live command list. */
export function createHelpCommand(listCommands: () => ReadonlyArray<Command>): Command {
	return {
		name: "help",
		description: "Show help",
		run(ctx: LifecycleCmdCtx) {
			const COMMAND_NAME_COL_WIDTH = 22;
			const lines = [...listCommands()]
				.map((c) => `  :${c.name.padEnd(COMMAND_NAME_COL_WIDTH)} ${c.description}`)
				.join("\n");
			ctx.writer.addNotice(`Commands:\n${lines}`);
			ctx.tui.requestRender();
		},
	};
}
