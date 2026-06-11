import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EvalHarness } from "../../eval/src/harness.js";
import { SKIP_REAL_LLM } from "../../eval/src/model.js";

describe.skipIf(SKIP_REAL_LLM)("multi-turn: tool result visible in follow-up turn", { tags: ["real-llm"] }, () => {
	let harness: EvalHarness;

	beforeAll(() => {
		harness = new EvalHarness();
	});

	afterAll(() => {
		harness = undefined!;
	});

	it("turn 2 can reference tool result from turn 1", async () => {
		const secret = randomUUID().slice(0, 8).toUpperCase();

		const metrics = await harness.run(
			async (ctx) => {
				await ctx.writeFile("token.txt", `token=${secret}\n`);
				const reply1 = await ctx.send({ text: "Read token.txt and tell me the token value. You must use a tool." });
				if (!reply1.includes(secret)) throw new Error(`Turn 1 reply missing secret: ${reply1.slice(0, 200)}`);

				const reply2 = await ctx.send({ text: "What was the token value you just told me?" });
				if (!reply2.includes(secret)) throw new Error(`Turn 2 reply missing secret: ${reply2.slice(0, 200)}`);
			},
			{ scenario: "multi-turn-history", scenarioTimeoutMs: 150_000 },
		);

		expect(metrics.passed).toBe(true);
	}, 150_000);
});
