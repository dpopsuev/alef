export interface Forum {
	id: string;
	name: string;
	contractId?: string;
	createdAt: number;
}

export interface Topic {
	id: string;
	forumId: string;
	name: string;
	stageId?: string;
	createdAt: number;
}

export interface Thread {
	id: string;
	topicId: string;
	parentThreadId?: string;
	name?: string;
	agentColor: string;
	agentRole: string;
	createdAt: number;
}

export interface Entry {
	id: string;
	threadId: string;
	agentColor: string;
	contentType: EntryContentType;
	content: string;
	parentId?: string;
	createdAt: number;
	metadata?: Record<string, unknown>;
}

export type EntryContentType = "text" | "tool_call" | "tool_result" | "decision" | "system";

export interface Edge {
	id: string;
	fromEntryId: string;
	toEntryId: string;
	edgeType: EdgeType;
}

export type EdgeType = "references" | "blocks" | "supersedes" | "responds_to" | "depends_on";

export interface Contract {
	id: string;
	goal: string;
	forumId: string;
	stages: ContractStage[];
	breakpoints: Breakpoint[];
	status: ContractStatus;
	createdAt: number;
}

export type ContractStatus = "active" | "paused" | "completed" | "failed";

export interface ContractStage {
	id: string;
	name: string;
	agentRole: string;
	agentCount: number;
	execution: "serial" | "parallel";
	dependsOn: string[];
	topicId?: string;
}

export interface Breakpoint {
	afterStage: string;
	notify: "gensec" | "hitl";
	condition?: string;
}

export interface ScopeRule {
	agentRole: string;
	read: string[];
	write: string[];
}
export interface BoardPath {
	boardId: string;
	forumId?: string;
	topicId?: string;
	threadId?: string;
	subThreadIds?: string[];
}

function normalizeBoardSegment(value: string, label: string): string {
	const normalized = value.trim();
	if (normalized.length === 0) {
		throw new Error(`Board path ${label} cannot be empty.`);
	}
	if (normalized.includes(".")) {
		throw new Error(`Board path ${label} cannot contain ".".`);
	}
	return normalized;
}

export function boardPathToSegments(path: BoardPath): string[] {
	const parts = [path.boardId];
	if (path.forumId) parts.push(path.forumId);
	if (path.topicId) parts.push(path.topicId);
	if (path.threadId) parts.push(path.threadId);
	if (path.subThreadIds) parts.push(...path.subThreadIds);
	return parts;
}

export function boardPathToString(path: BoardPath): string {
	return boardPathToSegments(path).join(" > ");
}

export function boardPathToAddress(path: BoardPath): string {
	return `#${boardPathToSegments(path).join(".")}`;
}

export function parseBoardAddress(address: string): BoardPath {
	const normalized = address.trim().replace(/^#/, "");
	if (normalized.length === 0) {
		throw new Error("Board address cannot be empty.");
	}

	const [boardId, forumId, topicId, threadId, ...subThreadIds] = normalized
		.split(".")
		.map((segment, index) => normalizeBoardSegment(segment, `segment ${index + 1}`));

	return {
		boardId,
		forumId,
		topicId,
		threadId,
		subThreadIds: subThreadIds.length > 0 ? subThreadIds : undefined,
	};
}

export function matchesScope(patterns: string[], path: string): boolean {
	for (const pattern of patterns) {
		if (pattern === "*") return true;
		const patternParts = pattern.split(".");
		const pathParts = path.split(".");
		if (patternParts.length > pathParts.length) continue;

		let match = true;
		for (let i = 0; i < patternParts.length; i++) {
			if (patternParts[i] !== "*" && patternParts[i] !== pathParts[i]) {
				match = false;
				break;
			}
		}
		if (match) return true;
	}
	return false;
}
