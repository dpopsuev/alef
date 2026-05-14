import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { MemLog } from "../packages/spine/src/event-log.js";
import { validateProtocolEvent } from "../packages/spine/src/protocol.js";
import { RuntimeDomainEventSpine } from "../packages/spine/src/spine.js";

type MatrixRowName = "unit" | "integration" | "contract" | "e2e" | "concurrency" | "security" | "robustness";
type RogybStage = "red" | "orange" | "green" | "yellow" | "blue";

interface MatrixRow {
	row: MatrixRowName;
	requiredFiles: string[];
}

const ROOT = resolve(import.meta.dirname, "..");

const MATRIX_ROWS: MatrixRow[] = [
	{
		row: "unit",
		requiredFiles: ["packages/coding-agent/test/event-log.test.ts", "packages/coding-agent/test/domain-event-spine.test.ts"],
	},
	{
		row: "integration",
		requiredFiles: ["packages/coding-agent/test/eda-contracts.test.ts", "packages/coding-agent/test/agent-session-runtime-events.test.ts"],
	},
	{
		row: "contract",
		requiredFiles: ["scripts/check-contract-protocols.ts", "packages/coding-agent/test/eda-contracts.test.ts"],
	},
	{
		row: "e2e",
		requiredFiles: [
			"packages/coding-agent/test/headless-referee-benchmark.test.ts",
			"packages/coding-agent/test/headless-process-proof.test.ts",
		],
	},
	{
		row: "concurrency",
		requiredFiles: ["packages/coding-agent/test/agent-session-concurrent.test.ts"],
	},
	{
		row: "security",
		requiredFiles: ["packages/coding-agent/test/supervisor-process-proof.test.ts", "packages/coding-agent/test/export-html-xss.test.ts"],
	},
	{
		row: "robustness",
		requiredFiles: ["packages/coding-agent/test/supervisor-process-proof.test.ts", "packages/coding-agent/test/streaming-buffer-robustness.test.ts"],
	},
];

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

function runRogybEvidence(): Record<RogybStage, "pass"> {
	const invalidInvoke = validateProtocolEvent("organ.invoke.v1", {
		schemaVersion: "v1",
		plane: "data",
		lane: "motory",
		seam: "corpus.organ",
		correlationId: "",
		organ: "fs",
		action: "file_read",
		args: {},
		source: "llm_tool_call",
		gate: "requested",
	});
	assert(!invalidInvoke.accepted, "ROGYB red failed: invalid invoke payload must be rejected.");
	assert(
		invalidInvoke.diagnostics.some((diagnostic) => diagnostic.path === "data.correlationId"),
		"ROGYB orange failed: diagnostics must include data.correlationId.",
	);

	const validInvoke = validateProtocolEvent("organ.invoke.v1", {
		schemaVersion: "v1",
		plane: "data",
		lane: "motory",
		seam: "corpus.organ",
		correlationId: "corr-rogyb",
		organ: "fs",
		action: "file_read",
		args: { path: "README.md" },
		source: "llm_tool_call",
		gate: "requested",
	});
	assert(validInvoke.accepted, "ROGYB green failed: valid invoke payload must be accepted.");

	const log = new MemLog();
	log.emit({
		kind: "organ.invoke.v1",
		data: {
			schemaVersion: "v1",
			plane: "data",
			lane: "motory",
			seam: "corpus.organ",
			correlationId: "corr-rogyb",
			organ: "fs",
			action: "file_read",
			args: { path: "README.md" },
			source: "llm_tool_call",
			gate: "requested",
		},
		source: "session",
		direction: "outbound",
	});
	log.emit({
		kind: "organ.result.v1",
		data: {
			schemaVersion: "v1",
			plane: "data",
			lane: "sensory",
			seam: "corpus.organ",
			correlationId: "corr-rogyb",
			organ: "fs",
			action: "file_read",
			status: "ok",
			isError: false,
			contentLength: 2,
			gate: "executed",
		},
		source: "session",
		direction: "inbound",
	});
	const metrics = log.protocolMetrics();
	assert(
		metrics.accepted === 2 && metrics.correlationContinuityFailures === 0,
		"ROGYB yellow failed: success telemetry counters are not stable.",
	);

	const first = replaySignature();
	const second = replaySignature();
	assert(
		JSON.stringify(second) === JSON.stringify(first),
		"ROGYB blue failed: replay signature drift detected.",
	);

	return {
		red: "pass",
		orange: "pass",
		green: "pass",
		yellow: "pass",
		blue: "pass",
	};
}

function replaySignature(): Array<Record<string, string | undefined>> {
	const spine = new RuntimeDomainEventSpine();
	spine.recordSessionEvent({
		type: "tool_execution_start",
		toolCallId: "corr-matrix",
		toolName: "bash",
		args: { command: "echo ok" },
	});
	spine.recordSessionEvent({
		type: "tool_execution_end",
		toolCallId: "corr-matrix",
		toolName: "bash",
		result: { content: [{ type: "text", text: "ok" }] },
		isError: false,
	});
	return spine
		.since(0)
		.filter((event) => event.kind === "organ.invoke.v1" || event.kind === "organ.result.v1" || event.kind === "signal.events.v1")
		.map((event) => {
			const data = event.data as Record<string, unknown>;
			return {
				kind: event.kind,
				traceId: event.traceId,
				seam: typeof data.seam === "string" ? data.seam : undefined,
				lane: typeof data.lane === "string" ? data.lane : undefined,
				action: typeof data.action === "string" ? data.action : undefined,
				signal: typeof data.signal === "string" ? data.signal : undefined,
				correlationId: typeof data.correlationId === "string" ? data.correlationId : undefined,
			};
		});
}

function checkMatrixRows(): Record<MatrixRowName, "pass"> {
	const result = {} as Record<MatrixRowName, "pass">;
	for (const row of MATRIX_ROWS) {
		for (const relativePath of row.requiredFiles) {
			const absolutePath = resolve(ROOT, relativePath);
			assert(existsSync(absolutePath), `Matrix row "${row.row}" is missing required file: ${relativePath}`);
		}
		result[row.row] = "pass";
	}
	return result;
}

const summary = {
	rogyb: runRogybEvidence(),
	matrix: checkMatrixRows(),
	releaseReadiness: {
		contractsGate: "npm run check:contracts",
		headlessGate: "npm run check:headless-proofs",
		tmuxGate: "npm run check:tui-tmux-proof",
	},
};

console.log(JSON.stringify(summary, null, 2));
