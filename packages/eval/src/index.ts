// Evaluation framework

export { type BaselineEntry, EvalBaseline, type RegressionReport } from "./baseline.js";
export {
	type CalibrationContract,
	type ContractField,
	type ContractFieldType,
	extractFields,
	foldContracts,
} from "./calibration-contract.js";
export { all, any, fileContains, fileExists, lintPasses, llmJudge, replyContains } from "./checker.js";
export { compileCheck } from "./checkers/compile.js";
export { terminalScript, terminalScriptFile } from "./checkers/terminal.js";
export { testCheck } from "./checkers/test.js";
export { defaultEvalOrgans } from "./default-organs.js";
export type {
	Checker,
	CheckerContext,
	CheckerResult,
	EvalKind,
	Evaluation,
	FixtureSet,
	Template,
	ToolLevel,
} from "./evaluation.js";
export type { EvaluationResult, EvaluationRunnerOptions, PassAtK } from "./evaluation-runner.js";
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
	formatTranscript,
	serializeReport,
} from "./harness.js";
export type { RunMetrics, ScoringRule, SpanRecord, TurnRecord } from "./metrics.js";
export {
	batchCorrelation,
	deriveturns,
	pearsonCorrelation,
	READ_ONLY_RULES,
	scoreSpans,
	WRITE_RULES,
} from "./metrics.js";
export { getEvalModel, SKIP_REAL_LLM } from "./model.js";
export { type PreflightConfig, type PreflightError, type PreflightReport, preflight } from "./preflight.js";
export {
	defaultUnitScorer,
	type PortStub,
	runUnitEval,
	runUnitEvalBaseline,
	type UnitCaseResult,
	type UnitEvalConfig,
	type UnitEvalReport,
	type UnitScorer,
} from "./resolution-unit.js";
export {
	appendRunRecord,
	buildRunRecord,
	type EvalScore,
	generateScoreboard,
	loadRunHistory,
	type RunRecord,
	writeScoreboard,
} from "./scoreboard.js";
export {
	assertPath,
	assertToolInTrace,
	loadTrace,
	summarizeTrace,
	type ToolSummary,
	type TraceEvent,
	type TraceLevel,
	TraceRecorder,
	type TraceSummary,
} from "./trace-recorder.js";
