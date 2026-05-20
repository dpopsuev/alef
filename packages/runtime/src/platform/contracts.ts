import type {
	AgentActionMetadata,
	AgentCapabilityAvailability,
	AgentCapabilityDefinition,
	AgentCapabilityKind,
	AgentTool,
} from "@dpopsuev/alef-agent-core";
import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@dpopsuev/alef-ai";

export type { AgentActionMetadata, AgentCapabilityAvailability, AgentCapabilityDefinition, AgentCapabilityKind };
export type * from "@dpopsuev/alef-discourse";

export interface SourceInfo {
	path: string;
	source: string;
	scope: "user" | "project" | "temporary";
	origin: "package" | "top-level";
	baseDir?: string;
}

export interface ToolDefinitionLike {
	name: string;
	label: string;
	description: string;
	parameters?: unknown;
	executionMode?: AgentTool["executionMode"];
	action?: AgentActionMetadata;
}

export interface PlatformActionInfo {
	name: string;
	label: string;
	description: string;
	action: AgentActionMetadata;
	parameters?: unknown;
	executionMode?: AgentTool["executionMode"];
	sourceInfo?: SourceInfo;
}

export interface CompletionRequest {
	model: Model<Api>;
	context: Context;
	options?: SimpleStreamOptions;
}

export interface CompletionPort {
	complete(request: CompletionRequest): Promise<AssistantMessageEventStream>;
}

export interface WorkingMemoryEntry {
	key: string;
	value: unknown;
}

export interface WorkingMemoryPort {
	get<T = unknown>(key: string): T | undefined;
	set(key: string, value: unknown): void;
	delete(key: string): boolean;
	clear(): void;
	list(): WorkingMemoryEntry[];
	snapshot(): Record<string, unknown>;
}

export interface SessionEntry {
	id: string;
	type: string;
	[key: string]: unknown;
}

export interface SessionContext {
	messages: unknown[];
	[key: string]: unknown;
}

export interface SessionMemoryPort {
	getMessages(): unknown[];
	getEntries(): SessionEntry[];
	buildContext(): SessionContext;
	getSessionId(): string;
	getSessionFile(): string | undefined;
}

export interface AgentMemoryPorts {
	session: SessionMemoryPort;
	working: WorkingMemoryPort;
}

export interface SessionManagerLike {
	getEntries(): SessionEntry[];
	buildSessionContext(): SessionContext;
	getSessionId(): string;
	getSessionFile(): string | undefined;
	getSessionDir(): string;
}
