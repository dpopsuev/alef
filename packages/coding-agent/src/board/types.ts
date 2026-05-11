/**
 * Board data model — the blackboard shared-state store.
 *
 * Hierarchy: Board > Forum > Topic > Thread > Entry
 * Threads are recursive (sub-threads).
 * Entries form a linked-list graph with typed edges.
 *
 * Backend: Dolt (Git-for-data SQL) for persistence,
 * in-memory for the active session.
 */

// ---------------------------------------------------------------------------
// Core entities
// ---------------------------------------------------------------------------

export interface Forum {
	id: string;
	name: string;
	contractId?: string;
	createdAt: number; // Unix ms
}

export interface Topic {
	id: string;
	forumId: string;
	name: string;
	stageId?: string; // links to ContractStage
	createdAt: number;
}

export interface Thread {
	id: string;
	topicId: string;
	parentThreadId?: string; // null for top-level, ID for sub-threads
	name?: string;
	agentColor: string; // canonical color name of the owning agent
	agentRole: string;
	createdAt: number;
}

export interface Entry {
	id: string;
	threadId: string;
	agentColor: string;
	contentType: EntryContentType;
	content: string;
	parentId?: string; // previous entry in thread (linked list)
	createdAt: number;
	metadata?: Record<string, unknown>;
}

export type EntryContentType = "text" | "tool_call" | "tool_result" | "decision" | "system";

// ---------------------------------------------------------------------------
// Edges — typed relationships between entries
// ---------------------------------------------------------------------------

export interface Edge {
	id: string;
	fromEntryId: string;
	toEntryId: string;
	edgeType: EdgeType;
}

export type EdgeType = "references" | "blocks" | "supersedes" | "responds_to" | "depends_on";

// ---------------------------------------------------------------------------
// Contract — execution plan defined by the General Secretary
// ---------------------------------------------------------------------------

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
	dependsOn: string[]; // stage IDs
	topicId?: string; // where results are written
}

export interface Breakpoint {
	afterStage: string; // stage ID
	notify: "gensec" | "hitl";
	condition?: string; // optional predicate
}

// ---------------------------------------------------------------------------
// Scope — discourse boundaries for agents
// ---------------------------------------------------------------------------

export interface ScopeRule {
	agentRole: string;
	/** Board paths the agent can read (glob patterns) */
	read: string[];
	/** Board paths the agent can write (glob patterns) */
	write: string[];
}

// ---------------------------------------------------------------------------
// Board path — addressing scheme
// ---------------------------------------------------------------------------

/**
 * Board path: "forum.name > topic.name > thread.name > subthread.name"
 * Used for scope matching and addressing.
 */
export interface BoardPath {
	forumId: string;
	topicId?: string;
	threadId?: string;
	subThreadIds?: string[];
}

export function boardPathToString(path: BoardPath): string {
	const parts = [path.forumId];
	if (path.topicId) parts.push(path.topicId);
	if (path.threadId) parts.push(path.threadId);
	if (path.subThreadIds) parts.push(...path.subThreadIds);
	return parts.join(" > ");
}

/**
 * Check if an agent with a given scope rule can access a board path.
 * Simple glob matching: "*" matches any segment.
 */
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
