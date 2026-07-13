import { InMemorySessionStore } from "@dpopsuev/alef-storage/memory";
import { describe, expect, it, vi } from "vitest";
import { rename, tag } from "../src/client/commands/session-meta-cmds.js";
import type { TuiHandlerContext } from "../src/client/commands/types.js";

function makeCtx(store: InMemorySessionStore) {
	const notices: string[] = [];
	const ctx = {
		store,
		writer: {
			addNotice: (text: string) => notices.push(text),
		},
		tui: { requestRender: vi.fn(), stop: vi.fn() },
		session: { state: { id: store.id, modelId: "test" } },
	} as unknown as TuiHandlerContext;
	return { ctx, notices };
}

describe(":rename and :tag commands", { tags: ["unit"] }, () => {
	it("renames with user source", async () => {
		const store = new InMemorySessionStore();
		const { ctx, notices } = makeCtx(store);
		rename.run(ctx, ["My", "session"]);
		await vi.waitFor(() => {
			expect(store.name()).toBe("My session");
			expect(notices.some((n) => n.includes("Renamed"))).toBe(true);
		});
		expect(store.nameSource()).toBe("user");
	});

	it("lists and mutates tags", async () => {
		const store = new InMemorySessionStore();
		const { ctx, notices } = makeCtx(store);

		tag.run(ctx, []);
		await vi.waitFor(() => expect(notices.at(-1)).toContain("(none)"));

		tag.run(ctx, ["add", "tui", "bugfix"]);
		await vi.waitFor(() => expect(store.tags()).toEqual(["tui", "bugfix"]));
		expect(store.tagsSource()).toBe("user");

		tag.run(ctx, ["rm", "bugfix"]);
		await vi.waitFor(() => expect(store.tags()).toEqual(["tui"]));

		tag.run(ctx, ["set", "picker,search"]);
		await vi.waitFor(() => expect(store.tags()).toEqual(["picker", "search"]));

		tag.run(ctx, ["clear"]);
		await vi.waitFor(() => expect(store.tags()).toEqual([]));
	});
});
