import { BUILD_INFO } from "../../boot/build-info.js";
import { RESTART_EXIT_CODE } from "../../boot/reboot-port.js";
import { parseCompactArgs, runManualCompact } from "./manual-compact.js";
import type { Command, LifecycleCmdCtx, TuiHandlerContext } from "./types.js";
import { attempt } from "./types.js";
import { createDefaultUpdateShell, parseUpdateArgs, resolveReboot, runUpdate } from "./update-service.js";

export { parseUpdateArgs } from "./update-service.js";

/** Clean up session and TUI, then exit with the restart code so the wrapper respawns us. */
async function cleanExitForRestart(ctx: LifecycleCmdCtx): Promise<void> {
	await ctx.session.dispose();
	ctx.tui.stop();
	process.exit(RESTART_EXIT_CODE);
}

const SPINNER_FRAMES = ["⣋", "⣙", "⣹", "⣸", "⣼", "⣴", "⣦", "⣧", "⣇", "⣏"];

/**
 * Unified update command. Environment-aware:
 *   dev (no flags):  build local code + restart
 *   dev --pull:      git pull + npm install + build + restart
 *   dev --check:     git fetch --dry-run status
 *   prod (no flags): check release + npm install -g + restart
 *   prod --check:    show available release without applying
 *
 * :restart is registered as an alias.
 */
export const update: Command = {
	name: "update",
	description: "Build/update and restart [:update [--pull] [--force] [--check]]",
	argumentHint: "--pull | --check | --force",
	run(ctx: LifecycleCmdCtx, args: string[]) {
		attempt(ctx, async () => {
			const { pull, force, checkOnly } = parseUpdateArgs(args);
			const reboot = resolveReboot();
			const shell = createDefaultUpdateShell();

			if (checkOnly) {
				if (BUILD_INFO.channel === "dev") {
					ctx.writer.addNotice("Checking git remote...");
				} else {
					ctx.writer.addNotice("Checking for updates...");
				}
				ctx.tui.requestRender(true);
			} else if (BUILD_INFO.channel === "dev" && !pull) {
				ctx.writer.addNotice("Building...");
				ctx.tui.requestRender(true);
			} else if (BUILD_INFO.channel === "dev" && pull) {
				ctx.writer.addNotice("Pulling and rebuilding...");
				ctx.tui.requestRender(true);
			} else {
				ctx.writer.addNotice("Checking for updates...");
				ctx.tui.requestRender(true);
			}

			let frame = 0;
			const spinnerNotice = ctx.writer.addLiveNotice("");
			const tick = (phase: string): void => {
				const f = SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!;
				spinnerNotice.setText(`${f}  ${phase}...`);
				frame++;
				ctx.tui.requestRender();
			};

			let timer: ReturnType<typeof setInterval> | undefined;
			if (!checkOnly) {
				const phase = BUILD_INFO.channel === "dev" && !pull ? "Building" : "Updating";
				tick(phase);
				timer = setInterval(() => tick(phase), 100);

				if (force && BUILD_INFO.channel === "dev") {
					const dirty = shell.gitStatusPorcelain().trim();
					if (dirty) {
						spinnerNotice.setText("Warning: dirty tree -- proceeding with --force");
						ctx.tui.requestRender(true);
					}
				}

				await new Promise<void>((r) => setTimeout(r, 50));
			}

			try {
				const result = await runUpdate({
					channel: BUILD_INFO.channel,
					pull,
					force,
					checkOnly,
					version: BUILD_INFO.version,
					shell,
					rebuild: reboot,
					respawn: async () => {
						await cleanExitForRestart(ctx);
					},
				});

				if (timer) clearInterval(timer);

				switch (result.kind) {
					case "aborted-dirty":
						spinnerNotice.setText(
							"Update aborted: working tree is dirty. Commit/stash, or :update --pull --force",
						);
						break;
					case "check":
						spinnerNotice.setText(result.detail);
						break;
					case "up-to-date":
						spinnerNotice.setText("Already on latest version.");
						break;
					case "available":
						spinnerNotice.setText(
							`Update available: ${BUILD_INFO.version} -> ${result.release.version}\n${result.release.changelog}\n\nTo apply: :update`,
						);
						break;
					case "rebuilt":
						spinnerNotice.setText("Build complete -- restarting...");
						ctx.tui.requestRender();
						await cleanExitForRestart(ctx);
						break;
					case "respawn":
						break;
					case "failed":
						spinnerNotice.setText(`\u2717 Failed: ${result.message}`);
						break;
				}
				ctx.tui.requestRender();
			} catch (err) {
				if (timer) clearInterval(timer);
				spinnerNotice.setText(`\u2717 Failed: ${err instanceof Error ? err.message : String(err)}`);
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
		ctx.writer.addNotice("(detached -- daemon keeps running)");
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
				ctx.writer.addNotice("(compaction unavailable -- no session store)");
				ctx.tui.requestRender();
				return;
			}
			const summarize = ctx.session.summarizeForCompaction ?? ctx.opts?.summarize;
			if (!summarize && strategy === "summarize") {
				ctx.writer.addNotice("(compaction unavailable -- no LLM summarizer)");
				ctx.tui.requestRender();
				return;
			}
			ctx.dispatch({ type: "adapter-signal", signalType: "context.compacting", payload: { active: true } });
			try {
				const { result, notice } = await runManualCompact({
					store,
					summarize: summarize ?? (() => ""),
					instructions,
					strategy,
				});
				if (result.compactedTurns > 0) {
					ctx.dispatch({
						type: "adapter-signal",
						signalType: "context.compacted",
						payload: {
							compactedTurns: result.compactedTurns,
							estimatedBefore: result.estimatedBefore,
							estimatedAfter: result.estimatedAfter,
						},
					});
				}
				ctx.writer.addNotice(notice);
				ctx.tui.requestRender();
			} finally {
				ctx.dispatch({ type: "adapter-signal", signalType: "context.compacting", payload: { active: false } });
			}
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

/** Dense session chrome formerly painted in the footer dashboard. */
export const status: Command = {
	name: "status",
	description: "Show session status (model, tokens, context) -- detail view",
	run(ctx: TuiHandlerContext) {
		const lines = [
			"Session status:",
			`  Model:     ${ctx.session.state.modelId}`,
			`  Thinking:  ${typeof ctx.session.getThinking === "function" ? ctx.session.getThinking() : "(n/a)"}`,
			`  Session:   ${ctx.session.state.id}`,
			`  Cwd:       ${ctx.opts?.cwd ?? "(unknown)"}`,
		];
		const stats = ctx.sessionTokens;
		if (stats) {
			lines.push("");
			lines.push(
				`  Tokens:    up${stats.input.toLocaleString()} down${stats.output.toLocaleString()} (total ${stats.total.toLocaleString()})`,
			);
			if (stats.costUsd > 0) lines.push(`  Cost:      $${stats.costUsd.toFixed(4)}`);
			if (stats.contextWindow > 0) {
				const fillPct = ((stats.contextFill / stats.contextWindow) * 100).toFixed(1);
				lines.push(
					`  Context:   ${stats.contextFill.toLocaleString()} / ${stats.contextWindow.toLocaleString()} (${fillPct}%)`,
				);
			}
		} else {
			lines.push("");
			lines.push("  Tokens:    (unavailable -- try :tokens after a turn)");
		}
		lines.push("");
		lines.push("Hints: :tokens -- :plan -- :help -- Tab inspect (while tools active)");
		ctx.writer.addNotice(lines.join("\n"));
		ctx.tui.requestRender();
	},
};

/** Build the :help command against a live command list (optional aliases). */
export function createHelpCommand(
	listCommands: () => ReadonlyArray<Command>,
	aliasesOf: (name: string) => readonly string[] = () => [],
): Command {
	return {
		name: "help",
		description: "Show help",
		run(ctx: LifecycleCmdCtx) {
			const COMMAND_NAME_COL_WIDTH = 22;
			const lines = [...listCommands()]
				.map((c) => {
					const aliases = aliasesOf(c.name);
					const names = aliases.length > 0 ? `${c.name}, ${aliases.join(", ")}` : c.name;
					return `  :${names.padEnd(COMMAND_NAME_COL_WIDTH)} ${c.description}`;
				})
				.join("\n");
			ctx.writer.addNotice(`Commands:\n${lines}`);
			ctx.tui.requestRender();
		},
	};
}
