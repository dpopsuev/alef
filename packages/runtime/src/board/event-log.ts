import { randomUUID } from "node:crypto";
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
	| { kind: "system.preflight.failed"; data: PreflightData };

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

export class MemLog implements EventLog {
	private events: Event[] = [];
	private hooks: EmitHook[] = [];
	private seenIds = new Set<string>();
	private _deadLetters: DeadLetter[] = [];

	emit(input: EventInput): number {
		const id = input.id ?? randomUUID();

		if (this.seenIds.has(id)) {
			const existing = this.events.find((e) => e.id === id);
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

		for (let i = 0; i < this.hooks.length; i++) {
			try {
				this.hooks[i](event);
			} catch (err) {
				this._deadLetters.push({
					event,
					error: err instanceof Error ? err.message : String(err),
					hookIndex: i,
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
