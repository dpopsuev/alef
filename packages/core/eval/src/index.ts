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
export { agentsMdCheck } from "./checkers/agents-md.js";
export { commentCheck } from "./checkers/comment.js";
export { commitQualityCheck } from "./checkers/commit-quality.js";
export { compileCheck } from "./checkers/compile.js";
export { coverageCheck } from "./checkers/coverage.js";
export { lintCheck } from "./checkers/lint.js";
export type { Mutation } from "./checkers/mutation.js";
export { mutationCheck, sumMutations } from "./checkers/mutation.js";
export type { Property } from "./checkers/property.js";
export { propertyCheck, SUM_PROPERTIES } from "./checkers/property.js";
export { terminalScript, terminalScriptFile } from "./checkers/terminal.js";
export { testCheck } from "./checkers/test.js";
export { toolCallsAreReal } from "./checkers/tool-use-detector.js";
export { defaultEvalAdapters } from "./default-adapters.js";
export { defineEvalSuite, stubSessionFactory, type EvalSuiteOptions } from "./eval-suite.js";
export type {
	Checker,
	CheckerContext,
	CheckerResult,
	EvalKind,
	EvalReport,
	Evaluation,
	FixtureSet,
	Phase,
	PhaseEvaluation,
	PhaseEvaluationResult,
	PhaseResult,
	Template,
	ToolLevel,
} from "./evaluation.js";
export type { EvaluationResult, EvaluationRunnerOptions, PassAtK } from "./evaluation-runner.js";
export { EvaluationRunner } from "./evaluation-runner.js";
export * as gitWorkflowEvaluations from "./evaluations/git-workflow.js";
export * as multiTurnEvaluations from "./evaluations/multi-turn.js";
// Evaluation suites
export * as readOnlyEvaluations from "./evaluations/read-only.js";
export * as toolUseRegressionEvaluations from "./evaluations/tool-use-regression.js";
export * as terminalBenchEvaluations from "./evaluations/terminal-bench.js";
export * as writeEvaluations from "./evaluations/write.js";
export type { EvaluatorAdapterOptions, EvaluatorAdapterState } from "./evaluator-adapter.js";
export { EvaluatorAdapter } from "./evaluator-adapter.js";
export {
	getAgentCommits,
	getAgentDiff,
	getChangedFiles,
	initGitWorkspace,
} from "./git-workspace.js";
export type { AgentHandle, HarnessOptions, WorkspaceFile } from "./harness.js";
export { assertAllToolsUsed, assertToolNotUsed, assertToolUsed, EvalHarness } from "./harness.js";
export type { JudgePanelResult, JudgeResult, JudgeSpec } from "./judge-panel-runner.js";
export { formatJudgePanelReport, JudgePanelRunner } from "./judge-panel-runner.js";
export type { JudgeFinding, JudgeReport, JudgeVerdict } from "./judging-adapter.js";
export { createJudgingAdapter } from "./judging-adapter.js";
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
export { formatPhaseReport, PhaseEvaluationRunner } from "./phase-runner.js";
export { type PreflightConfig, type PreflightError, type PreflightReport, preflight } from "./preflight.js";
export { formatReport, formatTranscript, serializeReport } from "./report.js";
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
