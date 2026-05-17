import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";

export const PROTOCOL_EVENT_KINDS = [
	"control.commands.v1",
	"control.events.v1",
	"organ.invoke.v1",
	"organ.result.v1",
	"signal.events.v1",
] as const;

export type ProtocolEventKind = (typeof PROTOCOL_EVENT_KINDS)[number];
export const PROTOCOL_SCHEMA_VERSION = "v1" as const;
export const CLOUD_EVENT_SPEC_VERSION = "1.0" as const;

export type ProtocolOrganName = string;
export type ProtocolPlane = "control" | "data" | "signal";
export type ProtocolLane = "sensory" | "motory" | "signatory";
export type ProtocolSeam = "supervisor.corpus" | "corpus.organ";
export type CanonicalLane = "sense" | "motor" | "signal";

export type ControlCommandName = "session.start" | "session.stop" | "session.abort" | "policy.update";

export interface ControlCommandV1Data {
	schemaVersion: "v1";
	plane: "control";
	lane: "signatory";
	seam: "supervisor.corpus";
	command: ControlCommandName;
	commandId: string;
	updateId?: string;
	causationId?: string;
	idempotencyKey?: string;
	sessionId?: string;
	runtimeId?: string;
	reason?: string;
	policy?: Record<string, unknown>;
}

export type ControlEventName =
	| "session.created"
	| "session.started"
	| "session.completed"
	| "session.updated"
	| "policy.updated";

export interface ControlEventV1Data {
	schemaVersion: "v1";
	plane: "control";
	lane: "signatory";
	seam: "supervisor.corpus";
	event: ControlEventName;
	commandId?: string;
	updateId?: string;
	causationId?: string;
	sessionId?: string;
	runtimeId?: string;
	reason?: string;
	policy?: Record<string, unknown>;
}

export type DataPlaneInvokeSource = "llm_tool_call" | "runtime";

export interface OrganInvokeV1Data {
	schemaVersion: "v1";
	plane: "data";
	lane: "motory";
	seam: "corpus.organ";
	correlationId: string;
	organ: ProtocolOrganName;
	action: string;
	args: Record<string, unknown>;
	source: DataPlaneInvokeSource;
	gate: "requested";
}

export type OrganResultGate = "executed" | "error" | "denied.phase" | "denied.hitl" | "pending.hitl";

export interface OrganResultV1Data {
	schemaVersion: "v1";
	plane: "data";
	lane: "sensory";
	seam: "corpus.organ";
	correlationId: string;
	organ: ProtocolOrganName;
	action: string;
	status: "ok" | "error";
	isError: boolean;
	contentLength: number;
	gate: OrganResultGate;
	error?: string;
}

export type SignalEventName =
	| "execute"
	| "result.ok"
	| "result.error"
	| "denied.phase"
	| "denied.hitl"
	| "pending.hitl"
	| "policy.notice";

export interface SignalEventV1Data {
	schemaVersion: "v1";
	plane: "signal";
	lane: "signatory";
	seam: ProtocolSeam;
	signal: SignalEventName;
	correlationId?: string;
	organ?: ProtocolOrganName;
	action?: string;
	details?: string;
}

export interface ProtocolEventDataMap {
	"control.commands.v1": ControlCommandV1Data;
	"control.events.v1": ControlEventV1Data;
	"organ.invoke.v1": OrganInvokeV1Data;
	"organ.result.v1": OrganResultV1Data;
	"signal.events.v1": SignalEventV1Data;
}

export interface ProtocolKernelInvariant {
	plane: ProtocolPlane;
	lane: ProtocolLane;
	seam: ProtocolSeam;
	requiresCorrelationId: boolean;
}

export type ProtocolValidationCode =
	| "ok"
	| "envelope_invalid"
	| "data_invalid"
	| "kernel_invariant_violation"
	| "missing_correlation";

export interface ProtocolValidationResult<TKind extends ProtocolEventKind = ProtocolEventKind> {
	kind: TKind;
	accepted: boolean;
	code: ProtocolValidationCode;
	seam: ProtocolSeam;
	correlationId?: string;
	diagnostics: ProtocolValidationDiagnostic[];
}

export const PROTOCOL_KERNEL_V1: Readonly<Record<ProtocolEventKind, ProtocolKernelInvariant>> = {
	"control.commands.v1": {
		plane: "control",
		lane: "signatory",
		seam: "supervisor.corpus",
		requiresCorrelationId: false,
	},
	"control.events.v1": {
		plane: "control",
		lane: "signatory",
		seam: "supervisor.corpus",
		requiresCorrelationId: false,
	},
	"organ.invoke.v1": {
		plane: "data",
		lane: "motory",
		seam: "corpus.organ",
		requiresCorrelationId: true,
	},
	"organ.result.v1": {
		plane: "data",
		lane: "sensory",
		seam: "corpus.organ",
		requiresCorrelationId: true,
	},
	"signal.events.v1": {
		plane: "signal",
		lane: "signatory",
		seam: "corpus.organ",
		requiresCorrelationId: false,
	},
} as const;

export interface ProtocolValidationDiagnostic {
	path: string;
	message: string;
}

export interface ProtocolEnvelope<TKind extends ProtocolEventKind = ProtocolEventKind> {
	specversion: "1.0";
	id: string;
	source: string;
	type: TKind;
	datacontenttype: "application/json";
	time: string;
	data: ProtocolEventDataMap[TKind];
}

export interface ProtocolEnvelopeInput<TKind extends ProtocolEventKind = ProtocolEventKind> {
	id?: string;
	source: string;
	type: TKind;
	data: unknown;
	timestamp?: number;
}

const ajv = new Ajv({
	allErrors: true,
	strict: true,
	allowUnionTypes: true,
});

const nonEmptyStringSchema = { type: "string", minLength: 1 } as const;
const optionalRecordSchema = {
	type: "object",
	additionalProperties: true,
} as const;
const protocolOrganNameSchema = {
	type: "string",
	minLength: 1,
	pattern: "^[a-z][a-z0-9_.-]*$",
} as const;
const protocolSeamSchema = {
	type: "string",
	enum: ["supervisor.corpus", "corpus.organ"],
} as const;

const protocolDataSchemas: Record<ProtocolEventKind, Record<string, unknown>> = {
	"control.commands.v1": {
		type: "object",
		additionalProperties: false,
		required: ["schemaVersion", "plane", "lane", "seam", "command", "commandId"],
		properties: {
			schemaVersion: { const: "v1" },
			plane: { const: "control" },
			lane: { const: "signatory" },
			seam: { const: "supervisor.corpus" },
			command: {
				type: "string",
				enum: ["session.start", "session.stop", "session.abort", "policy.update"],
			},
			commandId: nonEmptyStringSchema,
			updateId: nonEmptyStringSchema,
			causationId: nonEmptyStringSchema,
			idempotencyKey: nonEmptyStringSchema,
			sessionId: nonEmptyStringSchema,
			runtimeId: nonEmptyStringSchema,
			reason: nonEmptyStringSchema,
			policy: optionalRecordSchema,
		},
	},
	"control.events.v1": {
		type: "object",
		additionalProperties: false,
		required: ["schemaVersion", "plane", "lane", "seam", "event"],
		properties: {
			schemaVersion: { const: "v1" },
			plane: { const: "control" },
			lane: { const: "signatory" },
			seam: { const: "supervisor.corpus" },
			event: {
				type: "string",
				enum: ["session.created", "session.started", "session.completed", "session.updated", "policy.updated"],
			},
			commandId: nonEmptyStringSchema,
			updateId: nonEmptyStringSchema,
			causationId: nonEmptyStringSchema,
			sessionId: nonEmptyStringSchema,
			runtimeId: nonEmptyStringSchema,
			reason: nonEmptyStringSchema,
			policy: optionalRecordSchema,
		},
	},
	"organ.invoke.v1": {
		type: "object",
		additionalProperties: false,
		required: [
			"schemaVersion",
			"plane",
			"lane",
			"seam",
			"correlationId",
			"organ",
			"action",
			"args",
			"source",
			"gate",
		],
		properties: {
			schemaVersion: { const: "v1" },
			plane: { const: "data" },
			lane: { const: "motory" },
			seam: { const: "corpus.organ" },
			correlationId: nonEmptyStringSchema,
			organ: protocolOrganNameSchema,
			action: nonEmptyStringSchema,
			args: {
				type: "object",
				additionalProperties: true,
			},
			source: {
				type: "string",
				enum: ["llm_tool_call", "runtime"],
			},
			gate: { const: "requested" },
		},
	},
	"organ.result.v1": {
		type: "object",
		additionalProperties: false,
		required: [
			"schemaVersion",
			"plane",
			"lane",
			"seam",
			"correlationId",
			"organ",
			"action",
			"status",
			"isError",
			"contentLength",
			"gate",
		],
		properties: {
			schemaVersion: { const: "v1" },
			plane: { const: "data" },
			lane: { const: "sensory" },
			seam: { const: "corpus.organ" },
			correlationId: nonEmptyStringSchema,
			organ: protocolOrganNameSchema,
			action: nonEmptyStringSchema,
			status: {
				type: "string",
				enum: ["ok", "error"],
			},
			isError: { type: "boolean" },
			contentLength: { type: "number", minimum: 0 },
			gate: {
				type: "string",
				enum: ["executed", "error", "denied.phase", "denied.hitl", "pending.hitl"],
			},
			error: nonEmptyStringSchema,
		},
	},
	"signal.events.v1": {
		type: "object",
		additionalProperties: false,
		required: ["schemaVersion", "plane", "lane", "seam", "signal"],
		properties: {
			schemaVersion: { const: "v1" },
			plane: { const: "signal" },
			lane: { const: "signatory" },
			seam: protocolSeamSchema,
			signal: {
				type: "string",
				enum: [
					"execute",
					"result.ok",
					"result.error",
					"denied.phase",
					"denied.hitl",
					"pending.hitl",
					"policy.notice",
				],
			},
			correlationId: nonEmptyStringSchema,
			organ: protocolOrganNameSchema,
			action: nonEmptyStringSchema,
			details: nonEmptyStringSchema,
		},
	},
};

const protocolEnvelopeSchema: Record<string, unknown> = {
	type: "object",
	additionalProperties: false,
	required: ["specversion", "id", "source", "type", "datacontenttype", "time", "data"],
	properties: {
		specversion: { const: CLOUD_EVENT_SPEC_VERSION },
		id: nonEmptyStringSchema,
		source: nonEmptyStringSchema,
		type: {
			type: "string",
			enum: [...PROTOCOL_EVENT_KINDS],
		},
		datacontenttype: { const: "application/json" },
		time: nonEmptyStringSchema,
		data: {},
	},
};

const envelopeValidator = ajv.compile(protocolEnvelopeSchema);
const dataValidatorCache: Partial<Record<ProtocolEventKind, ValidateFunction<unknown>>> = {};

function getDataValidator(kind: ProtocolEventKind): ValidateFunction<unknown> {
	const existing = dataValidatorCache[kind];
	if (existing) {
		return existing;
	}
	const validator = ajv.compile(protocolDataSchemas[kind]);
	dataValidatorCache[kind] = validator;
	return validator;
}

function diagnosticsFromAjvErrors(
	errors: readonly ErrorObject[] | null | undefined,
	rootPath: string,
): ProtocolValidationDiagnostic[] {
	if (!errors || errors.length === 0) {
		return [];
	}
	return errors.map((error) => ({
		path: toDiagnosticPath(rootPath, error.instancePath),
		message: error.message ?? "Invalid value.",
	}));
}

function toDiagnosticPath(rootPath: string, instancePath: string): string {
	if (!instancePath) {
		return rootPath;
	}
	const normalized = instancePath.startsWith("/") ? instancePath.slice(1) : instancePath;
	if (normalized.length === 0) {
		return rootPath;
	}
	return `${rootPath}.${normalized.replaceAll("/", ".")}`;
}

function buildEnvelopeCandidate(input: ProtocolEnvelopeInput): Record<string, unknown> {
	const timestampMs =
		typeof input.timestamp === "number" && Number.isFinite(input.timestamp) ? input.timestamp : Date.now();
	return {
		specversion: CLOUD_EVENT_SPEC_VERSION,
		id: input.id ?? "generated-event-id",
		source: input.source,
		type: input.type,
		datacontenttype: "application/json",
		time: new Date(timestampMs).toISOString(),
		data: input.data,
	};
}

export function isProtocolEventKind(kind: string): kind is ProtocolEventKind {
	return (PROTOCOL_EVENT_KINDS as readonly string[]).includes(kind);
}

export function toCanonicalLane(lane: ProtocolLane): CanonicalLane {
	if (lane === "sensory") {
		return "sense";
	}
	if (lane === "motory") {
		return "motor";
	}
	return "signal";
}

export function fromCanonicalLane(lane: CanonicalLane): ProtocolLane {
	if (lane === "sense") {
		return "sensory";
	}
	if (lane === "motor") {
		return "motory";
	}
	return "signatory";
}

export function validateProtocolEventData(kind: ProtocolEventKind, data: unknown): ProtocolValidationDiagnostic[] {
	const validator = getDataValidator(kind);
	const valid = validator(data);
	if (valid) {
		return [];
	}
	return diagnosticsFromAjvErrors(validator.errors, "data");
}

export function validateProtocolEnvelope(input: ProtocolEnvelopeInput): ProtocolValidationDiagnostic[] {
	const envelope = buildEnvelopeCandidate(input);
	const envelopeIsValid = envelopeValidator(envelope);
	const diagnostics = envelopeIsValid ? [] : diagnosticsFromAjvErrors(envelopeValidator.errors, "envelope");
	diagnostics.push(...validateProtocolEventData(input.type, input.data));
	return diagnostics;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function hasNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function diagnosticsForKernelInvariant(kind: ProtocolEventKind, data: unknown): ProtocolValidationDiagnostic[] {
	if (!isRecord(data)) {
		return [];
	}

	const diagnostics: ProtocolValidationDiagnostic[] = [];
	const invariant = PROTOCOL_KERNEL_V1[kind];
	if (data.plane !== invariant.plane) {
		diagnostics.push({
			path: "data.plane",
			message: `Kernel invariant violation: expected plane "${invariant.plane}" for ${kind}.`,
		});
	}
	if (data.lane !== invariant.lane) {
		diagnostics.push({
			path: "data.lane",
			message: `Kernel invariant violation: expected lane "${invariant.lane}" for ${kind}.`,
		});
	}
	if (data.seam !== invariant.seam) {
		diagnostics.push({
			path: "data.seam",
			message: `Kernel invariant violation: expected seam "${invariant.seam}" for ${kind}.`,
		});
	}
	if (invariant.requiresCorrelationId && !hasNonEmptyString(data.correlationId)) {
		diagnostics.push({
			path: "data.correlationId",
			message: `Kernel invariant violation: ${kind} requires a non-empty correlationId.`,
		});
	}
	return diagnostics;
}

function dedupeDiagnostics(diagnostics: readonly ProtocolValidationDiagnostic[]): ProtocolValidationDiagnostic[] {
	const seen = new Set<string>();
	const deduped: ProtocolValidationDiagnostic[] = [];
	for (const diagnostic of diagnostics) {
		const key = `${diagnostic.path}\u0000${diagnostic.message}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		deduped.push(diagnostic);
	}
	return deduped;
}

export function protocolCorrelationId(kind: ProtocolEventKind, data: unknown): string | undefined {
	if (!isRecord(data)) {
		return undefined;
	}
	if (kind === "organ.invoke.v1" || kind === "organ.result.v1" || kind === "signal.events.v1") {
		return hasNonEmptyString(data.correlationId) ? data.correlationId : undefined;
	}
	return undefined;
}

export function validateProtocolEvent(kind: ProtocolEventKind, data: unknown): ProtocolValidationResult<typeof kind> {
	const schemaDiagnostics = validateProtocolEventData(kind, data);
	const kernelDiagnostics = diagnosticsForKernelInvariant(kind, data);
	const diagnostics = dedupeDiagnostics([...schemaDiagnostics, ...kernelDiagnostics]);
	const correlationId = protocolCorrelationId(kind, data);
	const hasKernelInvariantError = kernelDiagnostics.length > 0;
	const missingCorrelation = PROTOCOL_KERNEL_V1[kind].requiresCorrelationId && !correlationId;
	const accepted = diagnostics.length === 0;
	const code: ProtocolValidationCode = accepted
		? "ok"
		: missingCorrelation
			? "missing_correlation"
			: hasKernelInvariantError
				? "kernel_invariant_violation"
				: "data_invalid";
	return {
		kind,
		accepted,
		code,
		seam: PROTOCOL_KERNEL_V1[kind].seam,
		correlationId,
		diagnostics,
	};
}

export function validateProtocolEnvelopeReport<TKind extends ProtocolEventKind>(
	input: ProtocolEnvelopeInput<TKind>,
): ProtocolValidationResult<TKind> {
	const envelope = buildEnvelopeCandidate(input);
	const envelopeIsValid = envelopeValidator(envelope);
	const envelopeDiagnostics = envelopeIsValid ? [] : diagnosticsFromAjvErrors(envelopeValidator.errors, "envelope");
	const eventResult = validateProtocolEvent(input.type, input.data);
	const diagnostics = dedupeDiagnostics([...envelopeDiagnostics, ...eventResult.diagnostics]);
	if (diagnostics.length === 0) {
		return {
			kind: input.type,
			accepted: true,
			code: "ok",
			seam: eventResult.seam,
			correlationId: eventResult.correlationId,
			diagnostics: [],
		};
	}
	return {
		kind: input.type,
		accepted: false,
		code: envelopeDiagnostics.length > 0 ? "envelope_invalid" : eventResult.code,
		seam: eventResult.seam,
		correlationId: eventResult.correlationId,
		diagnostics,
	};
}
