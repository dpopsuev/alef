import { describe, expect, it, vi } from "vitest";
import { createCompactionStage, isCompacting } from "../src/context/compaction.js";

describe("createCompactionStage — compacting session gate", { tags: ["unit"] }, () => {
	it("isCompacting is true while summarize runs and false after", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const summarize = vi.fn(async () => {
			await gate;
			return "summary";
		});

		const stage = createCompactionStage({
			contextWindow: 10_000,
			reserveTokens: 2_000,
			keepRecentTokens: 200,
			getLastTokenCount: () => 0,
			summarize,
		});

		const bulk = "x".repeat(20_000);
		const pending = stage({
			messages: [
				{ role: "user", content: bulk },
				{ role: "assistant", content: bulk },
				{ role: "user", content: "recent" },
			],
			tools: [],
			turn: 1,
		});

		await vi.waitFor(() => {
			expect(summarize).toHaveBeenCalled();
		});
		expect(isCompacting(), "session must report compacting while summarize is in flight").toBe(true);

		release();
		await pending;
		expect(isCompacting()).toBe(false);
	});

	it("publishes context.compacting active true then false around summarize", async () => {
		const publishSignal = vi.fn();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});

		const stage = createCompactionStage({
			contextWindow: 10_000,
			reserveTokens: 2_000,
			keepRecentTokens: 200,
			getLastTokenCount: () => 0,
			publishSignal,
			summarize: async () => {
				await gate;
				return "summary";
			},
		});

		const bulk = "x".repeat(20_000);
		const pending = stage({
			messages: [
				{ role: "user", content: bulk },
				{ role: "assistant", content: bulk },
				{ role: "user", content: "recent" },
			],
			tools: [],
			turn: 1,
		});

		await vi.waitFor(() => {
			expect(publishSignal).toHaveBeenCalledWith("context.compacting", { active: true });
		});

		release();
		await pending;

		expect(publishSignal).toHaveBeenCalledWith("context.compacting", { active: false });
		const types = publishSignal.mock.calls.map((c) => c[0]);
		expect(types.indexOf("context.compacting")).toBeLessThan(types.lastIndexOf("context.compacting"));
	});
});
