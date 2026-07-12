import { statusGlyph } from "../theme.js";
import { openConfigPicker } from "./overlay-picker.js";
import { attempt, type Command, type MetaCmdCtx } from "./types.js";

export const meta: Command = {
	name: "meta",
	description: "Ask the Alef meta-agent — :meta <prompt>",
	run(ctx: MetaCmdCtx, args: string[]) {
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
			const m = await import("../../meta-agent.js");
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

export const directive: Command = {
	name: "directive",
	description: "Manage system prompt blocks — :directive or :directive enable|disable|toggle <id>",
	run(ctx: MetaCmdCtx, args: string[]) {
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
