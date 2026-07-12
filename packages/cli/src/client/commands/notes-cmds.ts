import type { Command, NotesCmdCtx } from "./types.js";

export const sticky: Command = {
	name: "sticky",
	description: "Attach a note to the session timeline (linked to recent events)",
	async run(ctx: NotesCmdCtx, args: string[]) {
		const text = args.join(" ").trim();
		if (!text) {
			ctx.writer.addNotice("Usage: :sticky <note text>");
			ctx.tui.requestRender();
			return;
		}
		if (!ctx.store) return;

		const allEvents = await ctx.store.events();
		const nearbyEvents = allEvents
			.filter((e) => e.bus === "command" || e.bus === "event")
			.slice(-5)
			.map((e) => ({ type: e.type, correlationId: e.correlationId, timestamp: e.timestamp }));

		await ctx.store.append({
			bus: "internal",
			type: "user.sticky",
			correlationId: "sticky",
			payload: { text, nearbyEvents },
			timestamp: Date.now(),
			actor: { address: ctx.opts?.humanAddress ?? "@you", type: "human" },
		});

		ctx.writer.addNotice(`\u{1F4CC} ${text}`);
		ctx.tui.requestRender();
	},
};

export const stickies: Command = {
	name: "stickies",
	description: "List all sticky notes in this session",
	async run(ctx: NotesCmdCtx) {
		if (!ctx.store) return;
		const all = await ctx.store.events();
		const notes = all.filter((e) => e.type === "user.sticky");
		if (notes.length === 0) {
			ctx.writer.addNotice("No sticky notes in this session.");
		} else {
			for (const s of notes) {
				const p = s.payload as { text?: string };
				const time = new Date(s.timestamp).toLocaleTimeString();
				ctx.writer.addNotice(`[${time}] ${p.text ?? ""}`);
			}
		}
		ctx.tui.requestRender();
	},
};
