import { describe, expect, it } from "vitest";
import { buildEventResult } from "../src/bus/event-builders.js";

describe("buildEventResult conditions", { tags: ["unit"] }, () => {
	it("lifts DomainCondition[] from payload onto the event", () => {
		const observedAt = 1;
		const event = buildEventResult(
			{
				type: "dot.observe",
				payload: { toolCallId: "t1" },
				correlationId: "c1",
				timestamp: 0,
				elapsed: 0,
			},
			{
				inside: true,
				conditions: [{ domain: "dot", key: "inside", value: true, confidence: 1, observedAt }],
			},
		);
		expect(event.conditions).toEqual([
			{ domain: "dot", key: "inside", value: true, confidence: 1, observedAt },
		]);
		expect(event.payload.toolCallId).toBe("t1");
	});

	it("omits conditions when payload has none", () => {
		const event = buildEventResult(
			{ type: "fs.read", payload: {}, correlationId: "c1", timestamp: 0, elapsed: 0 },
			{ content: "x" },
		);
		expect(event.conditions).toBeUndefined();
	});
});
