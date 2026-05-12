import { fauxAssistantMessage } from "@dpopsuev/alef-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { Harness } from "./suite/harness.js";
import { createHarness } from "./suite/harness.js";

describe("AgentSession burn budgets", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("blocks new prompts when the bound discourse-object budget is exhausted", async () => {
		harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("seeded")]);

		await harness.session.prompt("Seed topic");

		const topicId = harness.session.discourse.listTopics()[0]?.topic.id;
		expect(topicId).toBeDefined();

		harness.session.discourse.upsertBudgetPolicy({
			scope: "discourse_object",
			targetId: topicId,
			createdBy: "operator",
			day: {
				maxTokens: 20,
				abortAt: 15,
			},
		});
		harness.session.discourse.recordBudgetUsage({
			discourseObjectId: topicId,
			inputTokens: 10,
			outputTokens: 6,
		});

		await expect(harness.session.prompt("This should be blocked")).rejects.toThrow(
			/Budget abort: discourse_object day \d+\/20 tokens\./,
		);
	});
});
