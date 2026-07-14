import { describe, expect, it } from "vitest";
import { reportUsage } from "../src/handlers/response-handler.js";
import type { AssistantMessage } from "@dpopsuev/alef-ai/types";

describe("reportUsage", { tags: ["unit"] }, () => {
	it("forwards cache fields and modelId", () => {
		const finalMessage = {
			usage: {
				input: 10,
				output: 5,
				cacheRead: 3,
				cacheWrite: 1,
				totalTokens: 15,
				cost: { total: 0.02 },
			},
		} as AssistantMessage;

		const usage = reportUsage(finalMessage, "provider/model-x");
		expect(usage).toMatchObject({
			input: 10,
			output: 5,
			totalTokens: 15,
			costUsd: 0.02,
			cacheRead: 3,
			cacheWrite: 1,
			modelId: "provider/model-x",
		});
	});
});
