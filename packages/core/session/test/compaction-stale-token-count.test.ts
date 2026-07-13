import { describe, expect, it, vi } from "vitest";
import { createCompactionStage } from "../src/context/compaction.js";

describe("createCompactionStage — stale getLastTokenCount", { tags: ["unit"] }, () => {
	it("compacts when message estimate exceeds limit even if getLastTokenCount is stale low", async () => {
		const publishSignal = vi.fn();
		const stage = createCompactionStage({
			contextWindow: 10_000,
			threshold: 0.9,
			preserveRecentTurns: 2,
			getLastTokenCount: () => 1_000,
			summarize: () => "prior work summarized",
			publishSignal,
		});

		const bulk = "x".repeat(12_000);
		const result = await stage({
			messages: [
				{ role: "user", content: bulk },
				{ role: "assistant", content: bulk },
				{ role: "user", content: bulk },
				{ role: "assistant", content: bulk },
				{ role: "user", content: "keep recent user" },
				{ role: "assistant", content: "keep recent assistant" },
			],
			tools: [],
			turn: 1,
		});

		expect(result.messages, "must compact despite stale API token count").toBeDefined();
		expect(publishSignal).toHaveBeenCalledWith(
			"context.compacted",
			expect.objectContaining({ compactedTurns: expect.any(Number) }),
		);
	});
});
