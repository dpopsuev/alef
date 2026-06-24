/**
 * Coding agent real-LLM eval suite.
 *
 * Uses defineEvalSuite from core/eval — all boilerplate is upstream.
 * This file only provides: the eval list + the agent factory.
 *
 * Run:
 *   ALEF_TEST_LLM=1 npx vitest run --tags-filter=real-llm packages/profiles/coding/test/evaluations.test.ts
 *   ALEF_TEST_LLM=1 npx vitest run -t "ToolUse" packages/profiles/coding/test/evaluations.test.ts
 */

import { resolve } from "node:path";

import { InMemorySessionStore } from "@dpopsuev/alef-testkit";
import * as multiTurnEvals from "../../../core/eval/src/evaluations/multi-turn.js";
import * as readOnlyEvals from "../../../core/eval/src/evaluations/read-only.js";
import * as toolUseEvals from "../../../core/eval/src/evaluations/tool-use-regression.js";
import * as writeEvals from "../../../core/eval/src/evaluations/write.js";
import { defineEvalSuite, stubSessionFactory } from "../../../core/eval/src/index.js";
import { getEvalModel } from "../../../core/eval/src/model.js";
import { buildAgent } from "../../../agent/src/agent-kernel.js";
import { buildLlmAdapter } from "../../../agent/src/build-llm-adapter.js";
import { parseArgs } from "../../../agent/src/args.js";
import { createDefaultDirectives, registerAdapters } from "../../../agent/src/prompt.js";
import { createCodingAgentStack } from "../src/index.js";

defineEvalSuite({
	name: "coding agent evaluations",
	evals: [
		readOnlyEvals.planRefactoring,
		readOnlyEvals.auditModule,
		readOnlyEvals.blastRadius,
		readOnlyEvals.contextWarming,
		writeEvals.createHTTPServer,
		writeEvals.addTypeExport,
		writeEvals.fixFailingTest,
		writeEvals.refactorAsync,
		writeEvals.writeMiddleware,
		multiTurnEvals.proposeFirst,
		multiTurnEvals.memoRecall,
		multiTurnEvals.approveProposal,
		toolUseEvals.singleToolCall,
		toolUseEvals.multiToolCall,
		toolUseEvals.grepThenRead,
		toolUseEvals.complexMultiTool,
		toolUseEvals.writeFile,
	],
	agentFactory: async (workspace, signal) => {
		const model = getEvalModel();
		const args = { ...parseArgs([]), cwd: workspace, noTui: true };
		const sessionStore = new InMemorySessionStore();
		const stack = await createCodingAgentStack({
			cwd: workspace,
			model,
			getSignal: () => signal,
			sessionStore,
			subagentFactory: stubSessionFactory(model.id, model.contextWindow),
		});
		const directives = createDefaultDirectives({ tools: stack.adapters.flatMap((o) => o.tools), cwd: workspace });
		registerAdapters(directives, stack.adapters);
		const budgetChars = Math.floor(model.contextWindow * 0.1 * 4);
		const systemPrompt = directives.build(budgetChars);

		const llm = buildLlmAdapter({
			model,
			cfg: {},
			args,
			thinkingState: { level: undefined },
			getModel: () => model,
			getSignal: () => signal,
			schemaResolver: (name) => stack.pipeline.getSchemaResolver()?.(name),
			systemPrompt,
		});
		const agent = buildAgent({ llm, loopThreshold: 10 });
		for (const adapter of stack.adapters) agent.load(adapter);
		return agent;
	},
	benchmarkPath: resolve(__dirname, "../../../core/eval/benchmark.jsonl"),
	scoreboardPath: resolve(__dirname, "../../../core/eval/SCOREBOARD.md"),
});
