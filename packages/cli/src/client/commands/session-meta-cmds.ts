import { applySessionMetadataRefresh, normalizeSessionTags } from "@dpopsuev/alef-session/metadata";
import type { Command, TuiHandlerContext } from "./types.js";
import { attempt } from "./types.js";

/** Rename the current session (user-owned; freezes auto title). */
export const rename: Command = {
	name: "rename",
	description: "Rename this session [:rename <name>]",
	run(ctx: TuiHandlerContext, args: string[]) {
		const name = args.join(" ").trim();
		if (!name) {
			ctx.writer.addNotice("Usage: :rename <name>");
			ctx.tui.requestRender();
			return;
		}
		attempt(ctx, async () => {
			const store = ctx.store;
			if (!store) {
				ctx.writer.addNotice("(rename unavailable — no session store)");
				ctx.tui.requestRender();
				return;
			}
			await applySessionMetadataRefresh(store, {
				reason: "user_rename",
				title: name,
				nameSource: "user",
			});
			ctx.writer.addNotice(`Renamed session to "${store.name()}"`);
			ctx.tui.requestRender();
		});
	},
};

/** List / add / remove / set / clear session tags (user-owned; freezes LLM tags). */
export const tag: Command = {
	name: "tag",
	description: "Manage session tags [:tag | add|rm|set|clear …]",
	run(ctx: TuiHandlerContext, args: string[]) {
		attempt(ctx, async () => {
			const store = ctx.store;
			if (!store) {
				ctx.writer.addNotice("(tags unavailable — no session store)");
				ctx.tui.requestRender();
				return;
			}

			const [action, ...rest] = args;
			if (!action) {
				const tags = store.tags();
				ctx.writer.addNotice(tags.length > 0 ? `tags: ${tags.join(", ")}` : "tags: (none)");
				ctx.tui.requestRender();
				return;
			}

			const verb = action.toLowerCase();
			if (verb === "clear") {
				await applySessionMetadataRefresh(store, {
					reason: "user_tag",
					tags: [],
					tagSource: "user",
				});
				ctx.writer.addNotice("tags cleared");
				ctx.tui.requestRender();
				return;
			}

			if (verb === "add") {
				const incoming = rest.flatMap((part) => part.split(",")).filter(Boolean);
				if (incoming.length === 0) {
					ctx.writer.addNotice("Usage: :tag add <tag> [tag…]");
					ctx.tui.requestRender();
					return;
				}
				await applySessionMetadataRefresh(store, {
					reason: "user_tag",
					tags: incoming,
					mergeTags: true,
					tagSource: "user",
				});
				ctx.writer.addNotice(`tags: ${store.tags().join(", ") || "(none)"}`);
				ctx.tui.requestRender();
				return;
			}

			if (verb === "rm" || verb === "remove") {
				const remove = new Set(normalizeSessionTags(rest.flatMap((part) => part.split(","))));
				if (remove.size === 0) {
					ctx.writer.addNotice("Usage: :tag rm <tag> [tag…]");
					ctx.tui.requestRender();
					return;
				}
				const next = store.tags().filter((t) => !remove.has(t));
				await applySessionMetadataRefresh(store, {
					reason: "user_tag",
					tags: next,
					tagSource: "user",
				});
				ctx.writer.addNotice(`tags: ${store.tags().join(", ") || "(none)"}`);
				ctx.tui.requestRender();
				return;
			}

			if (verb === "set") {
				const incoming = rest.flatMap((part) => part.split(",")).filter(Boolean);
				if (incoming.length === 0) {
					ctx.writer.addNotice("Usage: :tag set <tag>[,tag…]");
					ctx.tui.requestRender();
					return;
				}
				await applySessionMetadataRefresh(store, {
					reason: "user_tag",
					tags: incoming,
					tagSource: "user",
				});
				ctx.writer.addNotice(`tags: ${store.tags().join(", ") || "(none)"}`);
				ctx.tui.requestRender();
				return;
			}

			ctx.writer.addNotice("Usage: :tag [add|rm|set|clear] …");
			ctx.tui.requestRender();
		});
	},
};
