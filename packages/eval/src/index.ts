// Evaluation framework

export { type BaselineEntry, EvalBaseline, type RegressionReport } from "./baseline.js";
export { all, any, fileContains, fileExists, replyContains } from "./checker.js";
export { compileCheck } from "./checkers/compile.js";
export { terminalScript, terminalScriptFile } from "./checkers/terminal.js";
export { testCheck } from "./checkers/test.js";
export type {
	Checker,
	CheckerContext,
	CheckerResult,
	Evaluation,
	FixtureSet,
	Template,
	ToolLevel,
} from "./evaluation.js";
export type { EvaluationResult } from "./evaluation-runner.js";
export { EvaluationRunner } from "./evaluation-runner.js";
export * as multiTurnEvaluations from "./evaluations/multi-turn.js";
// Evaluation suites
export * as readOnlyEvaluations from "./evaluations/read-only.js";
export * as terminalBenchEvaluations from "./evaluations/terminal-bench.js";
export * as writeEvaluations from "./evaluations/write.js";
export type { EvaluatorOrganOptions, EvaluatorOrganState } from "./evaluator-organ.js";
export { EvaluatorOrgan } from "./evaluator-organ.js";
export type { HarnessOptions, ScenarioContext, ScenarioFn, WorkspaceFile } from "./harness.js";
export {
	assertAllToolsUsed,
	assertToolNotUsed,
	assertToolUsed,
	EvalHarness,
	formatReport,
	serializeReport,
} from "./harness.js";
export type { RunMetrics, ScoringRule, SpanRecord } from "./metrics.js";
export {
	READ_ONLY_RULES,
	scoreSpans,
	WRITE_RULES,
} from "./metrics.js";
export { getEvalModel, SKIP_REAL_LLM } from "./model.js";
