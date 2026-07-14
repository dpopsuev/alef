import { execSync, spawn } from "node:child_process";
import { BUILD_INFO } from "../../boot/build-info.js";
import { checkLatestRelease } from "../../update/release-checker.js";
import { parseCompactArgs, runManualCompact } from "./manual-compact.js";
import type { Command, LifecycleCmdCtx, TuiHandlerContext } from "./types.js";
import { attempt } from "./types.js";

/**
 * Restart command: respawn Alef and resume the current session.
 */
export const restart: Command = {
	name: "restart",
	description: "Restart Alef, resuming current session",
	run(ctx: LifecycleCmdCtx) {
		attempt(ctx, async () => {
			const sessionId = ctx.session.state.id;
			ctx.writer.addNotice("Restarting...");
			ctx.tui.requestRender(true);

			spawn(process.execPath, [...process.argv.slice(1), "--resume", sessionId], {
				detached: true,
				stdio: "inherit",
			});

			await new Promise((resolve) => setTimeout(resolve, 500));
			await ctx.session.dispose();
			ctx.tui.stop();
			process.exit(0);
		});
	},
};

export const update: Command = {
	name: "update",
	description: "Update Alef to latest version and restart",
	run(ctx: LifecycleCmdCtx) {
		attempt(ctx, async () => {
			const sessionId = ctx.session.state.id;

			if (BUILD_INFO.channel === "dev") {
				ctx.writer.addNotice("Updating from git...");
				ctx.tui.requestRender(true);

				try {
					const dirty = execSync("git status --porcelain", { encoding: "utf-8" }).trim();
					if (dirty) {
						ctx.writer.addNotice("Update aborted: working tree is dirty. Commit or stash first.");
						ctx.tui.requestRender();
						return;
					}

					execSync("git pull", { stdio: "inherit" });

					ctx.writer.addNotice("Installing dependencies...");
					ctx.tui.requestRender(true);
					execSync("npm install", { stdio: "inherit" });

					ctx.writer.addNotice("Building...");
					ctx.tui.requestRender(true);
					execSync("npm run build", { stdio: "inherit" });

					ctx.writer.addNotice("Restarting...");
					ctx.tui.requestRender(true);

					spawn(process.execPath, [...process.argv.slice(1), "--resume", sessionId], {
						detached: true,
						stdio: "inherit",
					});

					await new Promise((resolve) => setTimeout(resolve, 500));
					await ctx.session.dispose();
					ctx.tui.stop();
					process.exit(0);
				} catch (error) {
					const message = error instanceof Error ? error.message : "unknown error";
					ctx.writer.addNotice(`Update failed: ${message}`);
					ctx.tui.requestRender();
				}
			} else {
				ctx.writer.addNotice("Checking for updates...");
				ctx.tui.requestRender(true);

				const release = await checkLatestRelease("dpopsuev", "alef", BUILD_INFO.version);

				if (!release) {
					ctx.writer.addNotice("Already on latest version.");
					ctx.tui.requestRender();
					return;
				}

				ctx.writer.addNotice(`Update available: ${BUILD_INFO.version} → ${release.version}`);
				ctx.writer.addNotice(`\nChangelog:\n${release.changelog}`);
				ctx.writer.addNotice(`\nTo update: npm update -g @dpopsuev/alef`);
				ctx.writer.addNotice(`Or install: npm install -g @dpopsuev/alef@${release.version}`);
				ctx.tui.requestRender();
			}
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
