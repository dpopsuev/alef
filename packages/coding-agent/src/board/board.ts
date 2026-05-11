/**
 * Board — the blackboard shared-state store.
 *
 * Interface-based: InMemoryBoard for development/testing,
 * DoltBoard for persistence (future).
 *
 * All operations are synchronous for the in-memory implementation.
 * The Dolt backend will use async where needed.
 */

import { randomUUID } from "node:crypto";
import type { Contract, Edge, EdgeType, Entry, EntryContentType, Forum, ScopeRule, Thread, Topic } from "./types.js";
import { matchesScope } from "./types.js";

// ---------------------------------------------------------------------------
// Board interface
// ---------------------------------------------------------------------------

export interface Board {
	// Forums
	createForum(name: string, contractId?: string): Forum;
	getForum(id: string): Forum | undefined;
	getForums(): Forum[];

	// Topics
	createTopic(forumId: string, name: string, stageId?: string): Topic;
	getTopic(id: string): Topic | undefined;
	getTopics(forumId: string): Topic[];

	// Threads
	createThread(topicId: string, agentColor: string, agentRole: string, name?: string, parentThreadId?: string): Thread;
	getThread(id: string): Thread | undefined;
	getThreads(topicId: string): Thread[];
	getSubThreads(parentThreadId: string): Thread[];

	// Entries
	appendEntry(
		threadId: string,
		agentColor: string,
		contentType: EntryContentType,
		content: string,
		metadata?: Record<string, unknown>,
	): Entry;
	getEntry(id: string): Entry | undefined;
	getEntries(threadId: string): Entry[];
	getEntriesByAgent(agentColor: string): Entry[];

	// Edges
	addEdge(fromEntryId: string, toEntryId: string, edgeType: EdgeType): Edge;
	getEdgesFrom(entryId: string): Edge[];
	getEdgesTo(entryId: string): Edge[];

	// Contracts
	setContract(contract: Contract): void;
	getContract(id: string): Contract | undefined;
	getActiveContract(forumId: string): Contract | undefined;

	// Scope
	checkAccess(agentColor: string, path: string, mode: "read" | "write"): boolean;
	setScopeRules(rules: ScopeRule[]): void;

	// Query
	search(query: string): Entry[];
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

export class InMemoryBoard implements Board {
	private forums = new Map<string, Forum>();
	private topics = new Map<string, Topic>();
	private threads = new Map<string, Thread>();
	private entries = new Map<string, Entry>();
	private edges: Edge[] = [];
	private contracts = new Map<string, Contract>();
	private scopeRules: ScopeRule[] = [];

	// -- Agent role to scope mapping (for access checks)
	private agentRoles = new Map<string, string>(); // color -> role

	// -- Forums ---------------------------------------------------------------

	createForum(name: string, contractId?: string): Forum {
		const forum: Forum = { id: randomUUID(), name, contractId, createdAt: Date.now() };
		this.forums.set(forum.id, forum);
		return forum;
	}

	getForum(id: string): Forum | undefined {
		return this.forums.get(id);
	}

	getForums(): Forum[] {
		return [...this.forums.values()];
	}

	// -- Topics ---------------------------------------------------------------

	createTopic(forumId: string, name: string, stageId?: string): Topic {
		if (!this.forums.has(forumId)) throw new Error(`Forum not found: ${forumId}`);
		const topic: Topic = { id: randomUUID(), forumId, name, stageId, createdAt: Date.now() };
		this.topics.set(topic.id, topic);
		return topic;
	}

	getTopic(id: string): Topic | undefined {
		return this.topics.get(id);
	}

	getTopics(forumId: string): Topic[] {
		return [...this.topics.values()].filter((t) => t.forumId === forumId);
	}

	// -- Threads --------------------------------------------------------------

	createThread(
		topicId: string,
		agentColor: string,
		agentRole: string,
		name?: string,
		parentThreadId?: string,
	): Thread {
		if (!this.topics.has(topicId)) throw new Error(`Topic not found: ${topicId}`);
		if (parentThreadId && !this.threads.has(parentThreadId))
			throw new Error(`Parent thread not found: ${parentThreadId}`);
		const thread: Thread = {
			id: randomUUID(),
			topicId,
			parentThreadId,
			name,
			agentColor,
			agentRole,
			createdAt: Date.now(),
		};
		this.threads.set(thread.id, thread);
		this.agentRoles.set(agentColor, agentRole);
		return thread;
	}

	getThread(id: string): Thread | undefined {
		return this.threads.get(id);
	}

	getThreads(topicId: string): Thread[] {
		return [...this.threads.values()].filter((t) => t.topicId === topicId && !t.parentThreadId);
	}

	getSubThreads(parentThreadId: string): Thread[] {
		return [...this.threads.values()].filter((t) => t.parentThreadId === parentThreadId);
	}

	// -- Entries --------------------------------------------------------------

	appendEntry(
		threadId: string,
		agentColor: string,
		contentType: EntryContentType,
		content: string,
		metadata?: Record<string, unknown>,
	): Entry {
		if (!this.threads.has(threadId)) throw new Error(`Thread not found: ${threadId}`);

		// Find the last entry in this thread (for linked list)
		const threadEntries = this.getEntries(threadId);
		const lastEntry = threadEntries.length > 0 ? threadEntries[threadEntries.length - 1] : undefined;

		const entry: Entry = {
			id: randomUUID(),
			threadId,
			agentColor,
			contentType,
			content,
			parentId: lastEntry?.id,
			createdAt: Date.now(),
			metadata,
		};
		this.entries.set(entry.id, entry);
		return entry;
	}

	getEntry(id: string): Entry | undefined {
		return this.entries.get(id);
	}

	getEntries(threadId: string): Entry[] {
		return [...this.entries.values()]
			.filter((e) => e.threadId === threadId)
			.sort((a, b) => a.createdAt - b.createdAt);
	}

	getEntriesByAgent(agentColor: string): Entry[] {
		return [...this.entries.values()]
			.filter((e) => e.agentColor === agentColor)
			.sort((a, b) => a.createdAt - b.createdAt);
	}

	// -- Edges ----------------------------------------------------------------

	addEdge(fromEntryId: string, toEntryId: string, edgeType: EdgeType): Edge {
		if (!this.entries.has(fromEntryId)) throw new Error(`Entry not found: ${fromEntryId}`);
		if (!this.entries.has(toEntryId)) throw new Error(`Entry not found: ${toEntryId}`);
		const edge: Edge = { id: randomUUID(), fromEntryId, toEntryId, edgeType };
		this.edges.push(edge);
		return edge;
	}

	getEdgesFrom(entryId: string): Edge[] {
		return this.edges.filter((e) => e.fromEntryId === entryId);
	}

	getEdgesTo(entryId: string): Edge[] {
		return this.edges.filter((e) => e.toEntryId === entryId);
	}

	// -- Contracts ------------------------------------------------------------

	setContract(contract: Contract): void {
		this.contracts.set(contract.id, contract);
	}

	getContract(id: string): Contract | undefined {
		return this.contracts.get(id);
	}

	getActiveContract(forumId: string): Contract | undefined {
		return [...this.contracts.values()].find((c) => c.forumId === forumId && c.status === "active");
	}

	// -- Scope ----------------------------------------------------------------

	setScopeRules(rules: ScopeRule[]): void {
		this.scopeRules = rules;
	}

	checkAccess(agentColor: string, path: string, mode: "read" | "write"): boolean {
		if (this.scopeRules.length === 0) return true; // No rules = open access

		const role = this.agentRoles.get(agentColor);
		if (!role) return false;

		const rules = this.scopeRules.filter((r) => r.agentRole === role);
		if (rules.length === 0) return false;

		for (const rule of rules) {
			const patterns = mode === "read" ? rule.read : rule.write;
			if (matchesScope(patterns, path)) return true;
		}
		return false;
	}

	// -- Query ----------------------------------------------------------------

	search(query: string): Entry[] {
		const lower = query.toLowerCase();
		return [...this.entries.values()]
			.filter((e) => e.content.toLowerCase().includes(lower))
			.sort((a, b) => a.createdAt - b.createdAt);
	}
}
