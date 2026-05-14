import { EventInputValidationError, MemLog } from "../packages/spine/src/event-log.js";
import {
	PROTOCOL_EVENT_KINDS,
	PROTOCOL_KERNEL_V1,
	validateProtocolEnvelopeReport,
	validateProtocolEvent,
} from "../packages/spine/src/protocol.js";
import { RuntimeDomainEventSpine } from "../packages/spine/src/spine.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

const validPayloads: Record<(typeof PROTOCOL_EVENT_KINDS)[number], unknown> = {
	"control.commands.v1": {
		schemaVersion: "v1",
		plane: "control",
		lane: "signatory",
		seam: "supervisor.corpus",
		command: "session.start",
		commandId: "cmd-1",
		sessionId: "session-1",
	},
	"control.events.v1": {
		schemaVersion: "v1",
		plane: "control",
		lane: "signatory",
		seam: "supervisor.corpus",
		event: "session.created",
		sessionId: "session-1",
	},
	"organ.invoke.v1": {
		schemaVersion: "v1",
		plane: "data",
		lane: "motory",
		seam: "corpus.organ",
		correlationId: "corr-1",
		organ: "fs",
		action: "file_read",
		args: { path: "README.md" },
		source: "llm_tool_call",
		gate: "requested",
	},
	"organ.result.v1": {
		schemaVersion: "v1",
		plane: "data",
		lane: "sensory",
		seam: "corpus.organ",
		correlationId: "corr-1",
		organ: "fs",
		action: "file_read",
		status: "ok",
		isError: false,
		contentLength: 12,
		gate: "executed",
	},
	"signal.events.v1": {
		schemaVersion: "v1",
		plane: "signal",
		lane: "signatory",
		seam: "corpus.organ",
		signal: "result.ok",
		correlationId: "corr-1",
		organ: "fs",
		action: "file_read",
	},
};

for (const kind of PROTOCOL_EVENT_KINDS) {
	const result = validateProtocolEvent(kind, validPayloads[kind]);
	assert(result.accepted, `Expected ${kind} sample payload to validate: ${JSON.stringify(result.diagnostics)}`);
	assert(result.code === "ok", `Expected ${kind} sample payload to return code=ok, got ${result.code}.`);
	assert(result.seam === PROTOCOL_KERNEL_V1[kind].seam, `Expected ${kind} seam to match kernel invariant.`);
	const envelopeResult = validateProtocolEnvelopeReport({
		id: `evt-${kind}`,
		source: "contract.check",
		type: kind,
		data: validPayloads[kind],
	});
	assert(
		envelopeResult.accepted,
		`Expected ${kind} sample envelope to validate: ${JSON.stringify(envelopeResult.diagnostics)}`,
	);
}

const invalidInvokeResult = validateProtocolEvent("organ.invoke.v1", {
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
assert(
	!invalidInvokeResult.accepted && invalidInvokeResult.code === "missing_correlation",
	`Expected invalid organ.invoke.v1 payload to reject with missing_correlation, got ${invalidInvokeResult.code}.`,
);

const customOrganResult = validateProtocolEvent("organ.invoke.v1", {
	schemaVersion: "v1",
	plane: "data",
	lane: "motory",
	seam: "corpus.organ",
	correlationId: "corr-custom",
	organ: "monolog",
	action: "monolog.write_note",
	args: { body: "remember this" },
	source: "llm_tool_call",
	gate: "requested",
});
assert(customOrganResult.accepted, "Expected custom organ names to validate under organ=* contract.");

const invalidLaneResult = validateProtocolEvent("organ.result.v1", {
	schemaVersion: "v1",
	plane: "data",
	lane: "motory",
	seam: "supervisor.corpus",
	correlationId: "corr-violation",
	organ: "fs",
	action: "file_read",
	status: "ok",
	isError: false,
	contentLength: 2,
	gate: "executed",
});
assert(
	!invalidLaneResult.accepted && invalidLaneResult.code === "kernel_invariant_violation",
	`Expected kernel invariant rejection for lane/seam mismatch, got ${invalidLaneResult.code}.`,
);

const invalidEnvelopeResult = validateProtocolEnvelopeReport({
	id: "evt-invalid-envelope",
	source: "",
	type: "control.events.v1",
	data: validPayloads["control.events.v1"],
});
assert(
	!invalidEnvelopeResult.accepted && invalidEnvelopeResult.code === "envelope_invalid",
	`Expected envelope_invalid code for malformed envelope, got ${invalidEnvelopeResult.code}.`,
);

const spine = new RuntimeDomainEventSpine();
spine.recordSessionEvent({
	type: "tool_execution_start",
	toolCallId: "corr-check",
	toolName: "file_read",
	args: { path: "README.md" },
});
spine.recordSessionEvent({
	type: "tool_execution_end",
	toolCallId: "corr-check",
	toolName: "file_read",
	result: { content: [{ type: "text", text: "ok" }] },
	isError: false,
});
const protocolEvents = spine
	.since(0)
	.filter((event) => event.kind === "organ.invoke.v1" || event.kind === "organ.result.v1" || event.kind === "signal.events.v1");
assert(protocolEvents.length >= 4, "Expected protocol fanout events for invoke/result/signals.");
assert(
	protocolEvents.some((event) => event.traceId === "corr-check"),
	"Expected protocol events to preserve traceId correlation.",
);
const invokeEvent = protocolEvents.find((event) => event.kind === "organ.invoke.v1");
const resultEvent = protocolEvents.find((event) => event.kind === "organ.result.v1");
const signalEvent = protocolEvents.find((event) => event.kind === "signal.events.v1");

assert((invokeEvent?.data as { lane?: string } | undefined)?.lane === "motory", "Expected invoke lane to be motory.");
assert((resultEvent?.data as { lane?: string } | undefined)?.lane === "sensory", "Expected result lane to be sensory.");
assert(
	(signalEvent?.data as { lane?: string; seam?: string } | undefined)?.lane === "signatory",
	"Expected signal lane to be signatory.",
);
assert(
	(signalEvent?.data as { lane?: string; seam?: string } | undefined)?.seam === "corpus.organ",
	"Expected signal seam to be corpus.organ.",
);

const replayOne = createReplaySignature();
const replayTwo = createReplaySignature();
assert(
	JSON.stringify(replayOne) === JSON.stringify(replayTwo),
	"Expected replay signatures to be deterministic across identical event streams.",
);

const metricsLog = new MemLog();
metricsLog.emit({
	kind: "organ.invoke.v1",
	data: validPayloads["organ.invoke.v1"] as (typeof validPayloads)["organ.invoke.v1"],
	source: "session",
	direction: "outbound",
});
metricsLog.emit({
	kind: "organ.result.v1",
	data: validPayloads["organ.result.v1"] as (typeof validPayloads)["organ.result.v1"],
	source: "session",
	direction: "inbound",
});
const acceptedMetrics = metricsLog.protocolMetrics();
assert(acceptedMetrics.accepted === 2, "Expected protocol metrics accepted counter to track valid traffic.");
assert(
	acceptedMetrics.correlationContinuityChecks === 1 && acceptedMetrics.correlationContinuityFailures === 0,
	"Expected correlation continuity metrics to pass for paired invoke/result events.",
);

try {
	metricsLog.emit({
		kind: "organ.result.v1",
		data: {
			schemaVersion: "v1",
			plane: "data",
			lane: "sensory",
			seam: "corpus.organ",
			correlationId: "",
			organ: "fs",
			action: "file_read",
			status: "error",
			isError: true,
			contentLength: 0,
			gate: "error",
		},
		source: "session",
		direction: "inbound",
	});
} catch (error) {
	assert(error instanceof EventInputValidationError, "Expected protocol gate failure to throw EventInputValidationError.");
}
const rejectedMetrics = metricsLog.protocolMetrics();
assert(rejectedMetrics.rejected >= 1, "Expected protocol metrics rejected counter to increment on invalid traffic.");
assert(
	rejectedMetrics.lastReject?.code === "missing_correlation",
	`Expected last reject code to be missing_correlation, got ${rejectedMetrics.lastReject?.code}.`,
);

function createReplaySignature(): Array<Record<string, string | undefined>> {
	const replaySpine = new RuntimeDomainEventSpine();
	replaySpine.recordSessionEvent({
		type: "tool_execution_start",
		toolCallId: "corr-replay",
		toolName: "bash",
		args: { command: "echo ok" },
	});
	replaySpine.recordSessionEvent({
		type: "tool_execution_end",
		toolCallId: "corr-replay",
		toolName: "bash",
		result: { content: [{ type: "text", text: "ok" }] },
		isError: false,
	});
	return replaySpine
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
