import { describe, expect, it } from "vitest";
import { turnsToMessages } from "../src/context/assembler.js";
import type { Turn } from "../src/contracts/storage.js";

describe("turnsToMessages — post-compaction checkpoints", { tags: ["unit"] }, () => {
	it("ignores conversationHistory checkpoints at or before afterTimestamp", () => {
		const bloated = [
			{ role: "user", content: "x".repeat(50_000) },
			{ role: "assistant", content: "y".repeat(50_000) },
		];
		const fresh = [
			{ role: "user", content: "after compact" },
			{ role: "assistant", content: "ok" },
		];
		const compactionAt = 1_000;
		const turns: Turn[] = [
			{
				id: "t1",
				turnIndex: 0,
				tokenCost: 100,
				typeWeight: 0,
				events: [
					{
						bus: "internal",
						type: "llm.checkpoint",
						correlationId: "c1",
						payload: { conversationHistory: bloated },
						timestamp: compactionAt - 1,
					},
					{
						bus: "command",
						type: "llm.response",
						correlationId: "c1",
						payload: { text: "old", conversationHistory: bloated },
						timestamp: compactionAt - 1,
					},
					{
						bus: "internal",
						type: "llm.checkpoint",
						correlationId: "c2",
						payload: { conversationHistory: fresh },
						timestamp: compactionAt + 10,
					},
				],
			},
		];

		const withFilter = turnsToMessages(turns, { afterTimestamp: compactionAt });
		expect(withFilter).toEqual(fresh);

		const withoutFilter = turnsToMessages(turns);
		expect(withoutFilter).toEqual(fresh);

		const onlyOld = turnsToMessages(
			[
				{
					...turns[0]!,
					events: turns[0]!.events.filter((event) => event.timestamp <= compactionAt),
				},
			],
			{ afterTimestamp: compactionAt },
		);
		expect(onlyOld.some((message) => String(message.content).includes("x".repeat(20)))).toBe(false);
	});
});
