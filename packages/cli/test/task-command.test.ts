import { describe, expect, it, vi } from "vitest";
import { tasks } from "../src/client/commands/task-cmds.js";
import type { TuiHandlerContext } from "../src/client/commands/types.js";

function makeContext(taskCount = 1): TuiHandlerContext {
	const dispatch = vi.fn();
	return {
		t: { primaryFg: { ansi16: 37 } } as unknown as TuiHandlerContext["t"],
		writer: { addNotice: vi.fn() } as unknown as TuiHandlerContext["writer"],
		tui: { requestRender: vi.fn(), stop: vi.fn() } as TuiHandlerContext["tui"],
		session: {} as TuiHandlerContext["session"],
		dispatch,
		abortCurrentTurn: undefined,
		setAbortCurrentTurn: vi.fn(),
		taskLedger:
			taskCount === 0
				? []
				: [
						{
							taskId: "task-1",
							profile: "coding",
							status: "running",
							startedAt: 1,
							lastActivityAt: 2,
							chunkTail: ["working"],
						},
					],
	};
}

describe(":tasks command", { tags: ["unit"] }, () => {
	it("shows a picker when tracked tasks exist", () => {
		const ctx = makeContext();
		tasks.run(ctx, []);
		expect(ctx.dispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "overlay.show",
				descriptor: expect.objectContaining({ id: "task-picker" }),
			}),
		);
	});

	it("reports empty state when no tracked tasks exist", () => {
		const ctx = makeContext(0);
		tasks.run(ctx, []);
		expect(ctx.writer.addNotice).toHaveBeenCalledWith("No tracked async tasks.");
	});
});
