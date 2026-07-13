/**
 * :plan — list / focus / backlog / show workspace plans.
 */

import { PlanStore } from "@dpopsuev/alef-tool-plan";
import type { Command, TuiHandlerContext } from "./types.js";
import { attempt } from "./types.js";

/**
 *
 */
function storeFrom(ctx: TuiHandlerContext): PlanStore | undefined {
	const cwd = ctx.opts?.cwd;
	if (!cwd) return undefined;
	return new PlanStore({ cwd });
}

/**
 *
 */
function formatList(store: PlanStore): string {
	const plans = store.list();
	if (plans.length === 0) return "plans: (none)";
	return plans
		.map((p) => {
			const mark = p.status === "active" ? "●" : p.status === "backlog" ? "○" : "✓";
			return `${mark} ${p.id}  [${p.phase}/${p.status}]  ${p.desired}`;
		})
		.join("\n");
}

/** Workspace plan shelf commands for the human. */
export const plan: Command = {
	name: "plan",
	description: "Plans — :plan | list | focus <id> | backlog | close <summary>",
	run(ctx: TuiHandlerContext, args: string[]) {
		// eslint-disable-next-line @typescript-eslint/require-await
		attempt(ctx, async () => {
			const store = storeFrom(ctx);
			if (!store) {
				ctx.writer.addNotice("(plan unavailable — no cwd)");
				ctx.tui.requestRender();
				return;
			}

			const [action, ...rest] = args;
			const verb = (action ?? "show").toLowerCase();

			if (verb === "list" || verb === "ls") {
				ctx.writer.addNotice(formatList(store));
				ctx.tui.requestRender();
				return;
			}

			if (verb === "focus") {
				const id = rest[0];
				if (!id) {
					ctx.writer.addNotice("Usage: :plan focus <id>");
					ctx.tui.requestRender();
					return;
				}
				try {
					const focused = store.focus(id);
					ctx.writer.addNotice(`Focused ${focused.id}\n${focused.renderSummary()}`);
				} catch (error) {
					ctx.writer.addNotice(error instanceof Error ? error.message : String(error));
				}
				ctx.tui.requestRender();
				return;
			}

			if (verb === "backlog") {
				store.backlog(rest[0]);
				ctx.writer.addNotice("Plan backlogged. No focused plan.");
				ctx.tui.requestRender();
				return;
			}

			if (verb === "close") {
				const focused = store.focused();
				if (!focused) {
					ctx.writer.addNotice("No focused plan to close.");
					ctx.tui.requestRender();
					return;
				}
				const summary = rest.join(" ").trim() || "closed by user";
				store.close(focused.id, summary);
				ctx.writer.addNotice(`Closed ${focused.id}`);
				ctx.tui.requestRender();
				return;
			}

			if (verb === "show" || !action) {
				const focused = store.focused();
				if (!focused) {
					ctx.writer.addNotice("No focused plan. Use :plan list or ask the agent to plan.open.");
					ctx.tui.requestRender();
					return;
				}
				ctx.writer.addNotice(focused.renderSummary());
				ctx.tui.requestRender();
				return;
			}

			ctx.writer.addNotice("Usage: :plan [list|focus <id>|backlog|close <summary>]");
			ctx.tui.requestRender();
		});
	},
};
