import { parseCompactArgs, runManualCompact } from "./manual-compact.js";
import type { Command, LifecycleCmdCtx, TuiHandlerContext } from "./types.js";
import { attempt } from "./types.js";

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
