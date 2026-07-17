/**
 * Coding agent real-LLM eval suite.
 *
 * Uses createHeadlessAgent — the same assembly as production minus TUI.
 * The eval is: production headless + eval harness. Nothing more.
 *
 * Run:
 *   ALEF_TEST_LLM=1 npx vitest run --tags-filter=real-llm packages/profiles/coding/test/evaluations.test.ts
 *   ALEF_TEST_LLM=1 npx vitest run -t "ToolUse" packages/profiles/coding/test/evaluations.test.ts
 */

import { resolve } from "node:path";

import { InMemorySessionStore } from "@dpopsuev/alef-testkit";
import * as foundryEvals from "../../../core/eval/src/evaluations/foundry.js";
import * as multiTurnEvals from "../../../core/eval/src/evaluations/multi-turn.js";
import * as readOnlyEvals from "../../../core/eval/src/evaluations/read-only.js";
import * as toolUseEvals from "../../../core/eval/src/evaluations/tool-use-regression.js";
import * as writeEvals from "../../../core/eval/src/evaluations/write.js";
import { defineEvalSuite, stubSessionFactory } from "../../../core/eval/src/index.js";
import { getEvalModel } from "../../../core/eval/src/model.js";
import { createAgent } from "@dpopsuev/alef-agent/create-agent";
import { createCodingAgentStack } from "../src/index.js";

defineEvalSuite({
	name: "coding agent evaluations",
	blueprint: "coding",
	evals: [
		readOnlyEvals.planRefactoring,
		readOnlyEvals.auditModule,
		readOnlyEvals.blastRadius,
		readOnlyEvals.contextWarming,
		foundryEvals.createFoundryTextTool,
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
		toolUseEvals.openEndedExploration,
		toolUseEvals.complexMultiTool,
		toolUseEvals.writeFile,
	],
	agentFactory: async (workspace, signal) => {
		const model = getEvalModel();
		const sessionStore = new InMemorySessionStore();
		const stack = await createCodingAgentStack({
			cwd: workspace,
			model,
			getSignal: () => signal,
			sessionStore,
			subagentFactory: stubSessionFactory(model.id, model.contextWindow),
		});
		const { agent } = await createAgent({
			cwd: workspace,
			model,
			adapters: stack.adapters,
			getSignal: () => signal,
		});
		return agent;
	},
	benchmarkPath: resolve(__dirname, "../../../core/eval/benchmark.jsonl"),
	scoreboardPath: resolve(__dirname, "../../../core/eval/SCOREBOARD.md"),
});
