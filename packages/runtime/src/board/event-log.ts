import { randomUUID } from "node:crypto";
import {
	type ControlCommandV1Data,
	type ControlEventV1Data,
	isProtocolEventKind,
	type OrganInvokeV1Data,
	type OrganResultV1Data,
	PROTOCOL_EVENT_KINDS,
	PROTOCOL_KERNEL_V1,
	type ProtocolEventKind,
	type ProtocolSeam,
	type ProtocolValidationCode,
	type ProtocolValidationDiagnostic,
	type ProtocolValidationResult,
	type SignalEventV1Data,
	validateProtocolEnvelopeReport,
} from "./protocol.js";

export interface AgentSpawnedData {
	agentId: string;
	color: string;
	role: string;
	schema: string;
}

export interface AgentStoppedData {
	agentId: string;
	color: string;
	reason: string;
}

export interface AgentHeartbeatData {
	agentId: string;
	memoryMB: number;
	uptime: number;
}

export interface UserInputData {
	text: string;
	images?: number;
}

export interface AssistantOutputData {
	text: string;
	model: string;
	tokens?: number;
}

export interface ToolCalledData {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
}

export interface ToolResultData {
	toolCallId: string;
	toolName: string;
	isError: boolean;
	contentLength: number;
}

export interface MemoryExtractedData {
	entities: string[];
	relations: number;
}

export interface MemoryLinkedData {
	fromId: string;
	toId: string;
	relation: string;
}

export interface MemoryCompactedData {
	windowSize: number;
	observationId: string;
	tokensSaved: number;
}

export interface MemoryRecalledData {
	nodeIds: string[];
	totalTokens: number;
}

export interface MemoryConflictData {
	entityId: string;
	oldValue: string;
	newValue: string;
	resolution: string;
}

export interface BoardEntryData {
	entryId: string;
	threadId: string;
	agentColor: string;
	contentType: string;
}

export interface BoardEdgeData {
	fromId: string;
	toId: string;
	edgeType: string;
}

export interface ContractCreatedData {
	contractId: string;
	goal: string;
	stageCount: number;
}

export interface ContractStageData {
	contractId: string;
	stageId: string;
	stageName: string;
}

export interface ContractBreakpointData {
	contractId: string;
	stageId: string;
	notify: string;
}

export interface ContractCompletedData {
	contractId: string;
	status: string;
}

export interface BuildEventData {
	duration?: number;
	error?: string;
}

export interface PreflightData {
	checks: Array<{ name: string; passed: boolean }>;
}

export interface SessionEventData {
	eventType: string;
}

export interface ExtensionEventData {
	eventType: string;
	extensionPath?: string;
}

export interface ExtensionErrorData {
	eventType: string;
	extensionPath: string;
	error: string;
}

export interface LectorIndexUpdatedData {
	stage: string;
	rootPath?: string;
	filePath?: string;
	symbols?: number;
	nodes?: number;
	edges?: number;
	lspEnabled?: boolean;
	lspReady?: boolean;
	treeSitterEnabled?: boolean;
	treeSitterReady?: boolean;
}

export interface LectorCacheEventData {
	cache: "doc" | "ast" | "outline" | "graph" | "query";
	key: string;
	ageMs?: number;
	ttlMs?: number;
}

export interface LectorErrorData {
	stage: string;
	error: string;
	details?: Record<string, unknown>;
}

export interface TurnMetricsData {
	turnIndex: number;
	strategy: string;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	toolExecution: "sequential" | "parallel";
	toolCallCount: number;
	toolResultCount: number;
	assistantTokens: number;
	steeringQueueDepth: number;
	followUpQueueDepth: number;
	domainEventCount: number;
	disableSteering: boolean;
	disableFollowUp: boolean;
	forceSequentialTools: boolean;
}

export interface EventInputValidationErrorInfo {
	kind: string;
	code?: ProtocolValidationCode;
	seam?: ProtocolSeam;
	correlationId?: string;
	diagnostics: ProtocolValidationDiagnostic[];
}

export interface ProtocolTrafficReject {
	kind: ProtocolEventKind;
	code: ProtocolValidationCode;
	seam: ProtocolSeam;
	correlationId?: string;
	diagnostics: ProtocolValidationDiagnostic[];
}

export interface ProtocolTrafficMetrics {
	accepted: number;
	rejected: number;
	acceptedByKind: Record<ProtocolEventKind, number>;
	rejectedByKind: Record<ProtocolEventKind, number>;
	acceptedBySeam: Record<ProtocolSeam, number>;
	rejectedBySeam: Record<ProtocolSeam, number>;
	correlationContinuityChecks: number;
	correlationContinuityFailures: number;
	pendingCorrelations: number;
	lastReject?: ProtocolTrafficReject;
}

export class EventInputValidationError extends Error {
	readonly info: EventInputValidationErrorInfo;

	constructor(info: EventInputValidationErrorInfo) {
		const detail = info.diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join("; ");
		const codePrefix = info.code ? `[${info.code}] ` : "";
		super(`Invalid event payload for ${info.kind}: ${codePrefix}${detail}`);
		this.name = "EventInputValidationError";
		this.info = info;
	}
}

export type DomainEvent =
	| { kind: "agent.spawned"; data: AgentSpawnedData }
	| { kind: "agent.stopped"; data: AgentStoppedData }
	| { kind: "agent.heartbeat"; data: AgentHeartbeatData }
	| { kind: "user.input"; data: UserInputData }
	| { kind: "assistant.output"; data: AssistantOutputData }
	| { kind: "tool.called"; data: ToolCalledData }
	| { kind: "tool.result"; data: ToolResultData }
	| { kind: "memory.extracted"; data: MemoryExtractedData }
	| { kind: "memory.linked"; data: MemoryLinkedData }
	| { kind: "memory.compacted"; data: MemoryCompactedData }
	| { kind: "memory.recalled"; data: MemoryRecalledData }
	| { kind: "memory.conflict"; data: MemoryConflictData }
	| { kind: "board.entry"; data: BoardEntryData }
	| { kind: "board.edge"; data: BoardEdgeData }
	| { kind: "contract.created"; data: ContractCreatedData }
	| { kind: "contract.stage.started"; data: ContractStageData }
	| { kind: "contract.stage.completed"; data: ContractStageData }
	| { kind: "contract.breakpoint"; data: ContractBreakpointData }
	| { kind: "contract.completed"; data: ContractCompletedData }
	| { kind: "system.build.started"; data: BuildEventData }
	| { kind: "system.build.completed"; data: BuildEventData }
	| { kind: "system.build.failed"; data: BuildEventData }
	| { kind: "system.preflight.passed"; data: PreflightData }
	| { kind: "system.preflight.failed"; data: PreflightData }
	| { kind: "session.event"; data: SessionEventData }
	| { kind: "extension.event"; data: ExtensionEventData }
	| { kind: "extension.error"; data: ExtensionErrorData }
	| { kind: "lector.index.updated"; data: LectorIndexUpdatedData }
	| { kind: "lector.cache.hit"; data: LectorCacheEventData }
	| { kind: "lector.cache.miss"; data: LectorCacheEventData }
	| { kind: "lector.error"; data: LectorErrorData }
	| { kind: "turn.metrics"; data: TurnMetricsData }
	| { kind: "control.commands.v1"; data: ControlCommandV1Data }
	| { kind: "control.events.v1"; data: ControlEventV1Data }
	| { kind: "organ.invoke.v1"; data: OrganInvokeV1Data }
	| { kind: "organ.result.v1"; data: OrganResultV1Data }
	| { kind: "signal.events.v1"; data: SignalEventV1Data };

export type EventKind = DomainEvent["kind"];

export interface Event<T extends DomainEvent = DomainEvent> {
	id: string;
	version: number;
	parentId?: string;
	traceId?: string;
	timestamp: number;
	source: string;
	direction: "inbound" | "outbound";
	kind: T["kind"];
	data: T["data"];
	index: number;
}

export interface DeadLetter {
	event: Event;
	error: string;
	hookIndex: number;
	timestamp: number;
}

export type EmitHook = (event: Event) => void;
export type FilterFn = (event: Event) => boolean;

export interface EventLog {
	emit(event: EventInput): number;
	since(index: number): Event[];
	len(): number;
	onEmit(hook: EmitHook): () => void;
	subscribe(filter: FilterFn, hook: EmitHook): () => void;
	deadLetters(): readonly DeadLetter[];
	protocolMetrics(): ProtocolTrafficMetrics;
}

export type EventInput = DomainEvent & {
	id?: string;
	version?: number;
	source: string;
	direction: "inbound" | "outbound";
	parentId?: string;
	traceId?: string;
	timestamp?: number;
};

export interface EventStore {
	append(event: Event): Promise<void>;
	readSince(index: number): Promise<Event[]>;
	len(): Promise<number>;
	close(): Promise<void>;
}

function createProtocolCounterByKind(): Record<ProtocolEventKind, number> {
	return PROTOCOL_EVENT_KINDS.reduce(
		(counters, kind) => {
			counters[kind] = 0;
			return counters;
		},
		{} as Record<ProtocolEventKind, number>,
	);
}

function createProtocolCounterBySeam(): Record<ProtocolSeam, number> {
	return {
		"supervisor.corpus": 0,
		"corpus.organ": 0,
	};
}

function createProtocolTrafficMetrics(): ProtocolTrafficMetrics {
	return {
		accepted: 0,
		rejected: 0,
		acceptedByKind: createProtocolCounterByKind(),
		rejectedByKind: createProtocolCounterByKind(),
		acceptedBySeam: createProtocolCounterBySeam(),
		rejectedBySeam: createProtocolCounterBySeam(),
		correlationContinuityChecks: 0,
		correlationContinuityFailures: 0,
		pendingCorrelations: 0,
	};
}

export class MemLog implements EventLog {
	private events: Event[] = [];
	private hooks: EmitHook[] = [];
	private seenIds = new Set<string>();
	private _deadLetters: DeadLetter[] = [];
	private protocolTraffic = createProtocolTrafficMetrics();
	private readonly pendingProtocolCorrelations = new Set<string>();

	emit(input: EventInput): number {
		let validationReport: ProtocolValidationResult | undefined;
		try {
			validationReport = validateEventInput(input);
		} catch (error) {
			this.recordRejectedProtocolTraffic(input, error);
			throw error;
		}
		const id = input.id ?? randomUUID();

		if (this.seenIds.has(id)) {
			const existing = this.events.find((event) => event.id === id);
			return existing?.index ?? -1;
		}

		const index = this.events.length;
		const event: Event = {
			id,
			version: input.version ?? 1,
			parentId: input.parentId,
			traceId: input.traceId,
			timestamp: input.timestamp ?? Date.now(),
			source: input.source,
			direction: input.direction,
			kind: input.kind,
			data: input.data,
			index,
		};

		this.events.push(event);
		this.seenIds.add(id);
		this.recordAcceptedProtocolTraffic(event, validationReport);

		for (let hookIndex = 0; hookIndex < this.hooks.length; hookIndex += 1) {
			try {
				this.hooks[hookIndex](event);
			} catch (err) {
				this._deadLetters.push({
					event,
					error: err instanceof Error ? err.message : String(err),
					hookIndex,
					timestamp: Date.now(),
				});
			}
		}

		return index;
	}

	since(index: number): Event[] {
		if (index < 0) index = 0;
		if (index >= this.events.length) return [];
		return this.events.slice(index);
	}

	len(): number {
		return this.events.length;
	}

	onEmit(hook: EmitHook): () => void {
		this.hooks.push(hook);
		return () => {
			const idx = this.hooks.indexOf(hook);
			if (idx !== -1) this.hooks.splice(idx, 1);
		};
	}

	subscribe(filter: FilterFn, hook: EmitHook): () => void {
		const wrapped: EmitHook = (event) => {
			if (filter(event)) hook(event);
		};
		return this.onEmit(wrapped);
	}

	deadLetters(): readonly DeadLetter[] {
		return this._deadLetters;
	}

	protocolMetrics(): ProtocolTrafficMetrics {
		return structuredClone(this.protocolTraffic);
	}

	private recordRejectedProtocolTraffic(input: EventInput, error: unknown): void {
		if (!isProtocolEventKind(input.kind)) {
			return;
		}
		if (!(error instanceof EventInputValidationError)) {
			return;
		}
		const seam = error.info.seam ?? PROTOCOL_KERNEL_V1[input.kind].seam;
		this.protocolTraffic.rejected += 1;
		this.protocolTraffic.rejectedByKind[input.kind] += 1;
		this.protocolTraffic.rejectedBySeam[seam] += 1;
		this.protocolTraffic.lastReject = {
			kind: input.kind,
			code: error.info.code ?? "data_invalid",
			seam,
			correlationId: error.info.correlationId,
			diagnostics: error.info.diagnostics,
		};
	}

	private recordAcceptedProtocolTraffic(event: Event, report: ProtocolValidationResult | undefined): void {
		if (!isProtocolEventKind(event.kind)) {
			return;
		}
		const seam = report?.seam ?? PROTOCOL_KERNEL_V1[event.kind].seam;
		const correlationId = report?.correlationId;
		this.protocolTraffic.accepted += 1;
		this.protocolTraffic.acceptedByKind[event.kind] += 1;
		this.protocolTraffic.acceptedBySeam[seam] += 1;

		if (event.kind === "organ.invoke.v1" && correlationId) {
			this.pendingProtocolCorrelations.add(correlationId);
		}

		if (event.kind === "organ.result.v1") {
			this.protocolTraffic.correlationContinuityChecks += 1;
			if (!correlationId || !this.pendingProtocolCorrelations.has(correlationId)) {
				this.protocolTraffic.correlationContinuityFailures += 1;
			} else {
				this.pendingProtocolCorrelations.delete(correlationId);
			}
		}

		this.protocolTraffic.pendingCorrelations = this.pendingProtocolCorrelations.size;
	}
}

function validateEventInput(input: EventInput): ProtocolValidationResult | undefined {
	const diagnostics: ProtocolValidationDiagnostic[] = [];
	let protocolReport: ProtocolValidationResult | undefined;
	if (typeof input.source !== "string" || input.source.trim().length === 0) {
		diagnostics.push({
			path: "source",
			message: "Expected source to be a non-empty string.",
		});
	}
	if (input.direction !== "inbound" && input.direction !== "outbound") {
		diagnostics.push({
			path: "direction",
			message: 'Expected direction to be "inbound" or "outbound".',
		});
	}
	if (isProtocolEventKind(input.kind)) {
		protocolReport = validateProtocolEnvelopeReport({
			id: input.id,
			source: input.source,
			type: input.kind,
			data: input.data,
			timestamp: input.timestamp,
		});
		diagnostics.push(...protocolReport.diagnostics);
	}
	if (diagnostics.length > 0) {
		throw new EventInputValidationError({
			kind: input.kind,
			code: protocolReport?.code,
			seam: protocolReport?.seam,
			correlationId: protocolReport?.correlationId,
			diagnostics,
		});
	}
	return protocolReport;
}

export function byKind(...kinds: EventKind[]): FilterFn {
	const set = new Set<string>(kinds);
	return (event) => set.has(event.kind);
}

export function bySource(source: string): FilterFn {
	return (event) => event.source === source;
}

export function byTrace(traceId: string): FilterFn {
	return (event) => event.traceId === traceId;
}

export function byDirection(direction: "inbound" | "outbound"): FilterFn {
	return (event) => event.direction === direction;
}

export function assertNever(x: never): never {
	throw new Error(`Unhandled event kind: ${x}`);
}

export class Cursor {
	private position = 0;

	poll(log: EventLog): Event[] {
		const events = log.since(this.position);
		if (events.length > 0) {
			this.position = events[events.length - 1].index + 1;
		}
		return events;
	}

	get pos(): number {
		return this.position;
	}

	reset(): void {
		this.position = 0;
	}
}
