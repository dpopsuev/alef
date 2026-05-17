import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@dpopsuev/alef-agent-core";
import type { Event, EventInput, EventLog } from "./event-log.js";
import { MemLog } from "./event-log.js";
import type {
	ControlCommandV1Data,
	ControlEventV1Data,
	OrganInvokeV1Data,
	OrganResultV1Data,
	ProtocolEventKind,
	ProtocolOrganName,
	ProtocolSeam,
	SignalEventV1Data,
} from "./protocol.js";

export interface ExtensionErrorLike {
	event: string;
	extensionPath: string;
	error: string;
}

export interface SessionEventLike {
	type: string;
	[key: string]: unknown;
}

interface TurnEndEventLike extends SessionEventLike {
	type: "turn_end";
	message: AgentMessage;
}

interface SessionInfoChangedEventLike extends SessionEventLike {
	type: "session_info_changed";
	name?: string;
}

interface ThinkingLevelChangedEventLike extends SessionEventLike {
	type: "thinking_level_changed";
	level: string;
}

interface ToolExecutionStartEventLike extends SessionEventLike {
	type: "tool_execution_start";
	toolCallId: string;
	toolName: string;
	args: unknown;
}

interface ToolExecutionEndEventLike extends SessionEventLike {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	result: unknown;
	isError: boolean;
}

interface MessageEndEventLike extends SessionEventLike {
	type: "message_end";
	message: AgentMessage;
}

interface CompactionEndEventLike extends SessionEventLike {
	type: "compaction_end";
	result?: {
		tokensBefore: number;
		firstKeptEntryId: string;
	};
}

export interface DomainEventSpine {
	emit(event: EventInput): number;
	registerOrgan(actionName: string, organName: ProtocolOrganName): void;
	snapshotOrganGraph(): OrganGraphSnapshot;
	snapshotSeamAudit(): SeamAuditSnapshot;
	recordControlCommand(command: ControlCommandV1Data): number;
	recordControlEvent(event: ControlEventV1Data): number;
	recordSessionEvent(event: SessionEventLike): number;
	recordExtensionError(error: ExtensionErrorLike): number;
	since(index: number): Event[];
	len(): number;
}

export interface OrganGraphBinding {
	mode: "action" | "namespace";
	match: string;
	organ: ProtocolOrganName;
}

export interface OrganGraphSnapshot {
	bindings: OrganGraphBinding[];
}

export interface SeamAuditSnapshot {
	totalProtocolEvents: number;
	seamCounts: Record<ProtocolSeam, number>;
	violations: number;
}

function expectedSeamForKind(kind: EventInput["kind"]): ProtocolSeam | undefined {
	switch (kind as ProtocolEventKind) {
		case "control.commands.v1":
		case "control.events.v1":
			return "supervisor.corpus";
		case "organ.invoke.v1":
		case "organ.result.v1":
		case "signal.events.v1":
			return "corpus.organ";
		default:
			return undefined;
	}
}

function protocolSeamFromEvent(event: Pick<EventInput, "kind" | "data">): ProtocolSeam | undefined {
	const expected = expectedSeamForKind(event.kind);
	if (!expected) {
		return undefined;
	}
	if (typeof event.data !== "object" || event.data === null) {
		return undefined;
	}
	const seam = (event.data as { seam?: unknown }).seam;
	return seam === "supervisor.corpus" || seam === "corpus.organ" ? seam : undefined;
}

export class RuntimeDomainEventSpine implements DomainEventSpine {
	private readonly organByAction = new Map<string, ProtocolOrganName>();
	private readonly organByNamespace = new Map<string, ProtocolOrganName>();
	private completerCorrelationCounter = 0;
	private readonly pendingCompleterCorrelations: string[] = [];
	private seamAudit: SeamAuditSnapshot = {
		totalProtocolEvents: 0,
		seamCounts: {
			"supervisor.corpus": 0,
			"corpus.organ": 0,
		},
		violations: 0,
	};

	constructor(private readonly log: EventLog = new MemLog()) {}

	emit(event: EventInput): number {
		this.enforceProtocolSeamBoundary(event);
		const seam = protocolSeamFromEvent(event);
		const index = this.log.emit(event);
		if (seam) {
			this.seamAudit.totalProtocolEvents += 1;
			this.seamAudit.seamCounts[seam] += 1;
		}
		return index;
	}

	snapshotOrganGraph(): OrganGraphSnapshot {
		const bindings: OrganGraphBinding[] = [];
		for (const [match, organ] of this.organByAction.entries()) {
			bindings.push({ mode: "action", match, organ });
		}
		for (const [namespace, organ] of this.organByNamespace.entries()) {
			bindings.push({ mode: "namespace", match: `${namespace}.*`, organ });
		}
		bindings.sort((left, right) => {
			if (left.mode !== right.mode) {
				return left.mode.localeCompare(right.mode);
			}
			if (left.match !== right.match) {
				return left.match.localeCompare(right.match);
			}
			return left.organ.localeCompare(right.organ);
		});
		return { bindings };
	}

	snapshotSeamAudit(): SeamAuditSnapshot {
		return structuredClone(this.seamAudit);
	}

	private enforceProtocolSeamBoundary(event: EventInput): void {
		const expectedSeam = expectedSeamForKind(event.kind);
		if (!expectedSeam) {
			return;
		}
		const actualSeam = protocolSeamFromEvent(event);
		if (actualSeam === expectedSeam) {
			return;
		}
		this.seamAudit.violations += 1;
		throw new Error(
			`Protocol seam boundary violation for ${event.kind}: expected ${expectedSeam}, received ${actualSeam ?? "undefined"}.`,
		);
	}

	private resolveOrganName(toolName: string): ProtocolOrganName {
		const normalizedAction = normalizeActionName(toolName);
		if (!normalizedAction) {
			return "unknown";
		}

		const direct = this.organByAction.get(normalizedAction);
		if (direct) {
			return direct;
		}

		for (const [namespace, organ] of this.organByNamespace.entries()) {
			if (normalizedAction.startsWith(`${namespace}.`) || normalizedAction.startsWith(`${namespace}_`)) {
				return organ;
			}
		}

		return inferOrganName(normalizedAction);
	}

	registerOrgan(actionName: string, organName: ProtocolOrganName): void {
		const normalizedAction = normalizeActionName(actionName);
		const normalizedOrgan = normalizeOrganName(organName);
		if (!normalizedAction || !normalizedOrgan) {
			return;
		}
		if (normalizedAction.endsWith(".*")) {
			const namespace = normalizedAction.slice(0, -2);
			if (namespace) {
				this.organByNamespace.set(namespace, normalizedOrgan);
			}
			return;
		}
		this.organByAction.set(normalizedAction, normalizedOrgan);
	}

	recordControlCommand(command: ControlCommandV1Data): number {
		return this.emit({
			kind: "control.commands.v1",
			data: command,
			source: "control",
			direction: "inbound",
		});
	}

	recordControlEvent(event: ControlEventV1Data): number {
		return this.emit({
			kind: "control.events.v1",
			data: event,
			source: "control",
			direction: "outbound",
		});
	}

	recordSessionEvent(event: SessionEventLike): number {
		const index = this.emit(mapSessionEvent(event));
		for (const protocolEvent of mapProtocolSessionEvents(event, (toolName) => this.resolveOrganName(toolName), {
			queue: (seed) => this.queueCompleterCorrelation(seed),
			consume: (seed) => this.consumeCompleterCorrelation(seed),
		})) {
			this.emit(protocolEvent);
		}
		return index;
	}

	recordExtensionError(error: ExtensionErrorLike): number {
		return this.emit({
			kind: "extension.error",
			data: {
				eventType: error.event,
				extensionPath: error.extensionPath,
				error: error.error,
			},
			source: "extension",
			direction: "inbound",
		});
	}

	since(index: number): Event[] {
		return this.log.since(index);
	}

	len(): number {
		return this.log.len();
	}

	private queueCompleterCorrelation(seed?: number): string {
		const correlationId = this.nextCompleterCorrelation(seed);
		this.pendingCompleterCorrelations.push(correlationId);
		return correlationId;
	}

	private consumeCompleterCorrelation(seed?: number): string {
		const correlationId = this.pendingCompleterCorrelations.shift();
		return correlationId ?? this.nextCompleterCorrelation(seed);
	}

	private nextCompleterCorrelation(seed?: number): string {
		this.completerCorrelationCounter += 1;
		const counter = this.completerCorrelationCounter;
		if (typeof seed === "number" && Number.isFinite(seed) && seed > 0) {
			return `completer-${Math.floor(seed)}-${counter}`;
		}
		return `completer-${counter}`;
	}
}

const COMPLETER_ACTION_NAME = "completer.complete";

interface CompleterCorrelationCallbacks {
	queue(seed?: number): string;
	consume(seed?: number): string;
}

function isAgentMessageLike(value: unknown): value is AgentMessage {
	return typeof value === "object" && value !== null && typeof (value as { role?: unknown }).role === "string";
}

function isTurnEndEvent(event: SessionEventLike): event is TurnEndEventLike {
	return event.type === "turn_end" && isAgentMessageLike(event.message);
}

function isSessionInfoChangedEvent(event: SessionEventLike): event is SessionInfoChangedEventLike {
	return event.type === "session_info_changed";
}

function isThinkingLevelChangedEvent(event: SessionEventLike): event is ThinkingLevelChangedEventLike {
	return event.type === "thinking_level_changed" && typeof event.level === "string";
}

function isToolExecutionStartEvent(event: SessionEventLike): event is ToolExecutionStartEventLike {
	return (
		event.type === "tool_execution_start" &&
		typeof event.toolCallId === "string" &&
		typeof event.toolName === "string" &&
		"args" in event
	);
}

function isToolExecutionEndEvent(event: SessionEventLike): event is ToolExecutionEndEventLike {
	return (
		event.type === "tool_execution_end" &&
		typeof event.toolCallId === "string" &&
		typeof event.toolName === "string" &&
		typeof event.isError === "boolean" &&
		"result" in event
	);
}

function isMessageEndEvent(event: SessionEventLike): event is MessageEndEventLike {
	return event.type === "message_end" && isAgentMessageLike(event.message);
}

function isCompactionEndEvent(event: SessionEventLike): event is CompactionEndEventLike {
	return event.type === "compaction_end";
}

function mapProtocolSessionEvents(
	event: SessionEventLike,
	resolveOrganName: (toolName: string) => ProtocolOrganName,
	completerCorrelations: CompleterCorrelationCallbacks,
): EventInput[] {
	switch (event.type) {
		case "turn_start": {
			const invokeData = mapCompleterInvokeData(resolveOrganName, completerCorrelations.queue);
			const signalData: SignalEventV1Data = {
				schemaVersion: "v1",
				plane: "signal",
				lane: "signatory",
				seam: "corpus.organ",
				signal: "execute",
				correlationId: invokeData.correlationId,
				organ: invokeData.organ,
				action: invokeData.action,
			};
			return [
				{
					kind: "organ.invoke.v1",
					data: invokeData,
					source: "session",
					direction: "outbound",
					traceId: invokeData.correlationId,
				},
				{
					kind: "signal.events.v1",
					data: signalData,
					source: "session",
					direction: "outbound",
					traceId: invokeData.correlationId,
				},
			];
		}
		case "turn_end": {
			if (!isTurnEndEvent(event)) {
				return [];
			}
			const resultData = mapCompleterResultData(event.message, resolveOrganName, completerCorrelations.consume);
			if (!resultData) {
				return [];
			}
			const signalData: SignalEventV1Data = {
				schemaVersion: "v1",
				plane: "signal",
				lane: "signatory",
				seam: "corpus.organ",
				signal: resultData.status === "ok" ? "result.ok" : "result.error",
				correlationId: resultData.correlationId,
				organ: resultData.organ,
				action: resultData.action,
				details: resultData.error,
			};
			return [
				{
					kind: "organ.result.v1",
					data: resultData,
					source: "session",
					direction: "inbound",
					traceId: resultData.correlationId,
				},
				{
					kind: "signal.events.v1",
					data: signalData,
					source: "session",
					direction: "inbound",
					traceId: resultData.correlationId,
				},
			];
		}
		case "agent_start":
			return [
				{
					kind: "control.events.v1",
					data: {
						schemaVersion: "v1",
						plane: "control",
						lane: "signatory",
						seam: "supervisor.corpus",
						event: "session.started",
					},
					source: "session",
					direction: "outbound",
				},
			];
		case "agent_end":
			return [
				{
					kind: "control.events.v1",
					data: {
						schemaVersion: "v1",
						plane: "control",
						lane: "signatory",
						seam: "supervisor.corpus",
						event: "session.completed",
					},
					source: "session",
					direction: "outbound",
				},
			];
		case "session_info_changed":
			if (!isSessionInfoChangedEvent(event)) {
				return [];
			}
			return [
				{
					kind: "control.events.v1",
					data: {
						schemaVersion: "v1",
						plane: "control",
						lane: "signatory",
						seam: "supervisor.corpus",
						event: "session.updated",
						reason: event.name ? `session name changed to ${event.name}` : "session metadata updated",
					},
					source: "session",
					direction: "outbound",
				},
			];
		case "thinking_level_changed":
			if (!isThinkingLevelChangedEvent(event)) {
				return [];
			}
			return [
				{
					kind: "control.events.v1",
					data: {
						schemaVersion: "v1",
						plane: "control",
						lane: "signatory",
						seam: "supervisor.corpus",
						event: "policy.updated",
						policy: {
							thinkingLevel: event.level,
						},
					},
					source: "session",
					direction: "outbound",
				},
			];
		case "tool_execution_start": {
			if (!isToolExecutionStartEvent(event)) {
				return [];
			}
			const invokeData = mapOrganInvokeData(event, resolveOrganName);
			const signalData: SignalEventV1Data = {
				schemaVersion: "v1",
				plane: "signal",
				lane: "signatory",
				seam: "corpus.organ",
				signal: "execute",
				correlationId: invokeData.correlationId,
				organ: invokeData.organ,
				action: invokeData.action,
			};
			return [
				{
					kind: "organ.invoke.v1",
					data: invokeData,
					source: "session",
					direction: "outbound",
					traceId: invokeData.correlationId,
				},
				{
					kind: "signal.events.v1",
					data: signalData,
					source: "session",
					direction: "outbound",
					traceId: invokeData.correlationId,
				},
			];
		}
		case "tool_execution_end": {
			if (!isToolExecutionEndEvent(event)) {
				return [];
			}
			const resultData = mapOrganResultData(event, resolveOrganName);
			const signalData: SignalEventV1Data = {
				schemaVersion: "v1",
				plane: "signal",
				lane: "signatory",
				seam: "corpus.organ",
				signal: resultData.status === "ok" ? "result.ok" : "result.error",
				correlationId: resultData.correlationId,
				organ: resultData.organ,
				action: resultData.action,
				details: resultData.error,
			};
			return [
				{
					kind: "organ.result.v1",
					data: resultData,
					source: "session",
					direction: "inbound",
					traceId: resultData.correlationId,
				},
				{
					kind: "signal.events.v1",
					data: signalData,
					source: "session",
					direction: "inbound",
					traceId: resultData.correlationId,
				},
			];
		}
		default:
			return [];
	}
}

function mapCompleterInvokeData(
	resolveOrganName: (toolName: string) => ProtocolOrganName,
	queueCompleterCorrelation: (seed?: number) => string,
	seed?: number,
): OrganInvokeV1Data {
	const correlationId = queueCompleterCorrelation(seed);
	const action = COMPLETER_ACTION_NAME;
	return {
		schemaVersion: "v1",
		plane: "data",
		lane: "motory",
		seam: "corpus.organ",
		correlationId,
		organ: resolveOrganName(action),
		action,
		args: {
			channel: "llm-api",
			kind: "completion",
			requestedAction: "cerebrum.complete",
			resolvedAction: COMPLETER_ACTION_NAME,
		},
		source: "runtime",
		gate: "requested",
	};
}

function mapCompleterResultData(
	message: AgentMessage,
	resolveOrganName: (toolName: string) => ProtocolOrganName,
	consumeCompleterCorrelation: (seed?: number) => string,
): OrganResultV1Data | undefined {
	if (message.role !== "assistant") {
		return undefined;
	}
	const correlationId = consumeCompleterCorrelation(message.timestamp);
	const action = COMPLETER_ACTION_NAME;
	const isError = message.stopReason === "error" || message.stopReason === "aborted";
	const outputText = textFromMessage(message);
	return {
		schemaVersion: "v1",
		plane: "data",
		lane: "sensory",
		seam: "corpus.organ",
		correlationId,
		organ: resolveOrganName(action),
		action,
		status: isError ? "error" : "ok",
		isError,
		contentLength: outputText.length,
		gate: isError ? "error" : "executed",
		error: isError ? (message.errorMessage ?? `assistant stopReason=${message.stopReason}`) : undefined,
	};
}

function mapOrganInvokeData(
	event: ToolExecutionStartEventLike,
	resolveOrganName: (toolName: string) => ProtocolOrganName,
): OrganInvokeV1Data {
	const correlationId = normalizeCorrelationId(event.toolCallId);
	return {
		schemaVersion: "v1",
		plane: "data",
		lane: "motory",
		seam: "corpus.organ",
		correlationId,
		organ: resolveOrganName(event.toolName),
		action: event.toolName,
		args: recordFromUnknown(event.args),
		source: "llm_tool_call",
		gate: "requested",
	};
}

function mapOrganResultData(
	event: ToolExecutionEndEventLike,
	resolveOrganName: (toolName: string) => ProtocolOrganName,
): OrganResultV1Data {
	const correlationId = normalizeCorrelationId(event.toolCallId);
	const status: OrganResultV1Data["status"] = event.isError ? "error" : "ok";
	return {
		schemaVersion: "v1",
		plane: "data",
		lane: "sensory",
		seam: "corpus.organ",
		correlationId,
		organ: resolveOrganName(event.toolName),
		action: event.toolName,
		status,
		isError: event.isError,
		contentLength: contentLength(event.result),
		gate: event.isError ? "error" : "executed",
		error: event.isError ? stringifyResult(event.result) : undefined,
	};
}

function normalizeCorrelationId(toolCallId: string | undefined): string {
	const trimmed = toolCallId?.trim();
	if (trimmed) {
		return trimmed;
	}
	return `tool-${randomUUID()}`;
}

function normalizeActionName(actionName: string | undefined): string {
	return actionName?.trim().toLowerCase() ?? "";
}

function normalizeOrganName(organName: string | undefined): ProtocolOrganName {
	return organName?.trim().toLowerCase() ?? "";
}

function inferOrganName(toolName: string): ProtocolOrganName {
	const name = toolName.toLowerCase();
	if (name === "supervisor") {
		return "supervisor";
	}
	if (name === "cerebrum.complete" || name.startsWith("cerebrum.complete_") || name.startsWith("cerebrum_complete")) {
		return "ai";
	}
	if (name === "completer" || name.startsWith("completer.") || name.startsWith("completer_")) {
		return "ai";
	}
	if (name === "bash" || name.startsWith("shell_") || name.startsWith("shell.") || name.startsWith("terminal_")) {
		return "shell";
	}
	if (
		name.startsWith("symbol_") ||
		name.startsWith("symbol.") ||
		name.startsWith("lector") ||
		name.includes("callers") ||
		name.includes("callees") ||
		name.includes("dataflow")
	) {
		return "lector";
	}
	if (name === "find" || name === "grep" || name === "ls" || name.startsWith("file_") || name.startsWith("file.")) {
		return "fs";
	}
	if (name.startsWith("agent.") || name.startsWith("session.")) {
		return "runtime";
	}
	const customOrgan = inferCustomOrganName(name);
	if (customOrgan) {
		return customOrgan;
	}
	return "unknown";
}

function inferCustomOrganName(toolName: string): string | undefined {
	const dottedPrefix = toolName.match(/^([a-z][a-z0-9-]*)\./)?.[1];
	if (dottedPrefix) {
		return dottedPrefix;
	}

	const underscoredPrefix = toolName.match(/^([a-z][a-z0-9-]*)_/)?.[1];
	if (underscoredPrefix && !["file", "shell", "symbol", "session", "agent", "terminal"].includes(underscoredPrefix)) {
		return underscoredPrefix;
	}

	return undefined;
}

function mapSessionEvent(event: SessionEventLike): EventInput {
	switch (event.type) {
		case "message_end":
			if (!isMessageEndEvent(event)) {
				return sessionEvent(event.type);
			}
			if (event.message.role === "user") {
				return {
					kind: "user.input",
					data: {
						text: textFromMessage(event.message),
						images: countImages(event.message),
					},
					source: "session",
					direction: "inbound",
				};
			}
			if (event.message.role === "assistant") {
				return {
					kind: "assistant.output",
					data: {
						model: event.message.model,
						text: textFromMessage(event.message),
						tokens: event.message.usage.totalTokens,
					},
					source: "session",
					direction: "outbound",
				};
			}
			return sessionEvent(event.type);
		case "tool_execution_start":
			if (!isToolExecutionStartEvent(event)) {
				return sessionEvent(event.type);
			}
			return {
				kind: "tool.called",
				data: {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: recordFromUnknown(event.args),
				},
				source: "session",
				direction: "outbound",
			};
		case "tool_execution_end":
			if (!isToolExecutionEndEvent(event)) {
				return sessionEvent(event.type);
			}
			return {
				kind: "tool.result",
				data: {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					isError: event.isError,
					contentLength: contentLength(event.result),
				},
				source: "session",
				direction: "inbound",
			};
		case "compaction_end":
			if (!isCompactionEndEvent(event)) {
				return sessionEvent(event.type);
			}
			if (event.result) {
				return {
					kind: "memory.compacted",
					data: {
						windowSize: event.result.tokensBefore,
						observationId: event.result.firstKeptEntryId,
						tokensSaved: event.result.tokensBefore,
					},
					source: "session",
					direction: "outbound",
				};
			}
			return sessionEvent(event.type);
		default:
			return sessionEvent(event.type);
	}
}

function sessionEvent(eventType: string): EventInput {
	return {
		kind: "session.event",
		data: { eventType },
		source: "session",
		direction: "outbound",
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : { value };
}

function textFromMessage(message: AgentMessage): string {
	switch (message.role) {
		case "user":
			return textFromContent(message.content);
		case "assistant":
			return textFromContent(message.content);
		case "toolResult":
			return textFromContent(message.content);
		case "custom":
			return textFromContent(message.content);
		case "branchSummary":
			return message.summary;
		case "compactionSummary":
			return message.summary;
		case "bashExecution":
			return message.output;
		default:
			return "";
	}
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.map((item) => {
			if (!isRecord(item)) {
				return "";
			}
			if (item.type === "text" && typeof item.text === "string") {
				return item.text;
			}
			return "";
		})
		.filter((item) => item.length > 0)
		.join("\n");
}

function countImages(message: AgentMessage): number {
	if (message.role !== "user" && message.role !== "toolResult" && message.role !== "custom") {
		return 0;
	}
	const content = message.content;
	if (!Array.isArray(content)) {
		return 0;
	}
	let count = 0;
	for (const item of content) {
		if (isRecord(item) && item.type === "image") {
			count += 1;
		}
	}
	return count;
}

function contentLength(value: unknown): number {
	if (typeof value === "string") {
		return value.length;
	}
	if (Array.isArray(value)) {
		return value.reduce((acc, item) => acc + contentLength(item), 0);
	}
	if (isRecord(value)) {
		if ("content" in value) {
			return contentLength(value.content);
		}
		if (value.type === "text" && typeof value.text === "string") {
			return value.text.length;
		}
	}
	return 0;
}

function stringifyResult(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
