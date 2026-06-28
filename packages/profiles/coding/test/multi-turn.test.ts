import { randomUUID } from "node:crypto";
import { InMemorySessionStore } from "@dpopsuev/alef-testkit";
import { buildLlmAdapter } from "../../../cli/src/boot/build-llm-adapter.js";
import { parseArgs } from "../../../cli/src/boot/args.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EvalHarness } from "../../../core/eval/src/harness.js";
import { getEvalModel, SKIP_REAL_LLM } from "../../../core/eval/src/model.js";
import { createCodingAgentStack } from "../src/index.js";

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
		const model = getEvalModel();

		const metrics = await harness.run(
			async (ctx) => {
				await ctx.writeFile("token.txt", `token=${secret}\n`);
				const reply1 = await ctx.send({ text: "Read token.txt and tell me the token value. You must use a tool." });
				if (!reply1.includes(secret)) throw new Error(`Turn 1 reply missing secret: ${reply1.slice(0, 200)}`);

				const reply2 = await ctx.send({ text: "What was the token value you just told me?" });
				if (!reply2.includes(secret)) throw new Error(`Turn 2 reply missing secret: ${reply2.slice(0, 200)}`);
			},
			{
				scenario: "multi-turn-history",
				scenarioTimeoutMs: 150_000,
				asyncAdapterFactory: async (workspace, signal) => {
					const sessionStore = new InMemorySessionStore();
					const stubFactory = () => ({
						state: { id: "eval", modelId: model.id, contextWindow: model.contextWindow },
						getModel: () => model.id, setModel: () => {}, getThinking: () => "off" as const,
						setThinking: () => {}, setTurnController: () => {}, subscribe: () => () => {},
						send: async () => "", dispose: () => {},
					});
					const stack = await createCodingAgentStack({
						cwd: workspace,
						model,
						getSignal: () => signal,
						sessionStore,
						subagentFactory: stubFactory,
					});
					const llm = buildLlmAdapter({
						model,
						cfg: {},
						args: { ...parseArgs([]), cwd: workspace, noTui: true },
						thinkingState: { level: undefined },
						getModel: () => model,
						getSignal: () => signal,
						schemaResolver: (name) => stack.contextAssembly.getSchemaResolver()?.(name),
					});
					return [...stack.adapters, llm];
				},
			},
		);

		expect(metrics.passed).toBe(true);
	}, 150_000);
});
