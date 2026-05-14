import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
	AgentCapacity,
	BudgetLedgerEntry,
	BudgetPolicy,
	ChildAgentSummary,
	DiscourseBoard,
	DiscourseClaim,
	DiscourseForum,
	DiscourseLetter,
	DiscourseRouteAffinity,
	DiscourseStamp,
	DiscourseTemplate,
	DiscourseThread,
	DiscourseTopic,
	KnowledgeAtom,
	KnowledgeMolecule,
	ReviewComment,
	SessionManagerLike,
} from "./contracts.js";

export interface DoltStoreSnapshot {
	boards: DiscourseBoard[];
	forums: DiscourseForum[];
	routeAffinities: DiscourseRouteAffinity[];
	templates: DiscourseTemplate[];
	topics: DiscourseTopic[];
	threads: DiscourseThread[];
	letters: DiscourseLetter[];
	claims: DiscourseClaim[];
	stamps: DiscourseStamp[];
	runtimes: ChildAgentSummary[];
	knowledgeAtoms: KnowledgeAtom[];
	knowledgeMolecules: KnowledgeMolecule[];
	budgetPolicies: BudgetPolicy[];
	budgetLedger: BudgetLedgerEntry[];
	agentCapacity?: AgentCapacity;
	comments: ReviewComment[];
}

export interface DoltStoreDriver {
	loadSnapshot(): DoltStoreSnapshot;
	upsertBoard(board: DiscourseBoard): void;
	upsertForum(forum: DiscourseForum): void;
	upsertRouteAffinity(affinity: DiscourseRouteAffinity): void;
	upsertTemplate(template: DiscourseTemplate): void;
	upsertTopic(topic: DiscourseTopic): void;
	upsertThread(thread: DiscourseThread): void;
	insertLetter(letter: DiscourseLetter): void;
	upsertClaim(claim: DiscourseClaim): void;
	upsertStamp(stamp: DiscourseStamp): void;
	upsertRuntime(runtime: ChildAgentSummary): void;
	upsertKnowledgeAtom(atom: KnowledgeAtom): void;
	upsertKnowledgeMolecule(molecule: KnowledgeMolecule): void;
	upsertBudgetPolicy(policy: BudgetPolicy): void;
	upsertBudgetLedger(entry: BudgetLedgerEntry): void;
	upsertAgentCapacity(capacity: AgentCapacity): void;
	insertComment(comment: ReviewComment): void;
}

function cloneValue<T>(value: T): T {
	return structuredClone(value);
}

function parseJsonRows(output: string): Record<string, unknown>[] {
	const trimmed = output.trim();
	if (!trimmed) {
		return [];
	}
	const parsed = JSON.parse(trimmed) as unknown;
	if (Array.isArray(parsed)) {
		return parsed as Record<string, unknown>[];
	}
	if (parsed && typeof parsed === "object") {
		if (Array.isArray((parsed as { rows?: unknown[] }).rows)) {
			return (parsed as { rows: Record<string, unknown>[] }).rows;
		}
		if (Array.isArray((parsed as { queries?: Array<{ rows?: unknown[] }> }).queries)) {
			return ((parsed as { queries: Array<{ rows?: Record<string, unknown>[] }> }).queries[0]?.rows ?? []) as Record<
				string,
				unknown
			>[];
		}
	}
	return [];
}

function parseString(value: unknown): string | undefined {
	return typeof value === "string" ? value : value === null || value === undefined ? undefined : String(value);
}

function parsePayload<T>(row: Record<string, unknown>): T | undefined {
	const payload = parseString(row.payload_json);
	if (!payload) {
		return undefined;
	}
	try {
		return JSON.parse(payload) as T;
	} catch {
		return undefined;
	}
}

function parsePayloadRows<T>(rows: Record<string, unknown>[]): T[] {
	return rows
		.map((row) => parsePayload<T>(row))
		.filter((value): value is T => value !== undefined)
		.map((value) => cloneValue(value));
}

function sqlLiteral(value: string | number | undefined): string {
	if (value === undefined) {
		return "NULL";
	}
	if (typeof value === "number") {
		return Number.isFinite(value) ? String(value) : "NULL";
	}
	return `'${value.replace(/'/g, "''")}'`;
}

function sqlJson(value: unknown): string {
	return sqlLiteral(JSON.stringify(value ?? null));
}

export class InMemoryDoltStoreDriver implements DoltStoreDriver {
	private readonly boards = new Map<string, DiscourseBoard>();
	private readonly forums = new Map<string, DiscourseForum>();
	private readonly routeAffinities = new Map<string, DiscourseRouteAffinity>();
	private readonly templates = new Map<string, DiscourseTemplate>();
	private readonly topics = new Map<string, DiscourseTopic>();
	private readonly threads = new Map<string, DiscourseThread>();
	private readonly letters = new Map<string, DiscourseLetter>();
	private readonly claims = new Map<string, DiscourseClaim>();
	private readonly stamps = new Map<string, DiscourseStamp>();
	private readonly runtimes = new Map<string, ChildAgentSummary>();
	private readonly knowledgeAtoms = new Map<string, KnowledgeAtom>();
	private readonly knowledgeMolecules = new Map<string, KnowledgeMolecule>();
	private readonly budgetPolicies = new Map<string, BudgetPolicy>();
	private readonly budgetLedger = new Map<string, BudgetLedgerEntry>();
	private readonly comments = new Map<string, ReviewComment>();
	private agentCapacity: AgentCapacity | undefined;

	loadSnapshot(): DoltStoreSnapshot {
		return {
			boards: Array.from(this.boards.values()).map((value) => cloneValue(value)),
			forums: Array.from(this.forums.values()).map((value) => cloneValue(value)),
			routeAffinities: Array.from(this.routeAffinities.values()).map((value) => cloneValue(value)),
			templates: Array.from(this.templates.values()).map((value) => cloneValue(value)),
			topics: Array.from(this.topics.values()).map((value) => cloneValue(value)),
			threads: Array.from(this.threads.values()).map((value) => cloneValue(value)),
			letters: Array.from(this.letters.values()).map((value) => cloneValue(value)),
			claims: Array.from(this.claims.values()).map((value) => cloneValue(value)),
			stamps: Array.from(this.stamps.values()).map((value) => cloneValue(value)),
			runtimes: Array.from(this.runtimes.values()).map((value) => cloneValue(value)),
			knowledgeAtoms: Array.from(this.knowledgeAtoms.values()).map((value) => cloneValue(value)),
			knowledgeMolecules: Array.from(this.knowledgeMolecules.values()).map((value) => cloneValue(value)),
			budgetPolicies: Array.from(this.budgetPolicies.values()).map((value) => cloneValue(value)),
			budgetLedger: Array.from(this.budgetLedger.values()).map((value) => cloneValue(value)),
			agentCapacity: this.agentCapacity ? cloneValue(this.agentCapacity) : undefined,
			comments: Array.from(this.comments.values()).map((value) => cloneValue(value)),
		};
	}

	upsertBoard(board: DiscourseBoard): void {
		this.boards.set(board.id, cloneValue(board));
	}

	upsertForum(forum: DiscourseForum): void {
		this.forums.set(forum.id, cloneValue(forum));
	}

	upsertRouteAffinity(affinity: DiscourseRouteAffinity): void {
		this.routeAffinities.set(affinity.id, cloneValue(affinity));
	}

	upsertTemplate(template: DiscourseTemplate): void {
		this.templates.set(template.id, cloneValue(template));
	}

	upsertTopic(topic: DiscourseTopic): void {
		this.topics.set(topic.id, cloneValue(topic));
	}

	upsertThread(thread: DiscourseThread): void {
		this.threads.set(thread.id, cloneValue(thread));
	}

	insertLetter(letter: DiscourseLetter): void {
		this.letters.set(letter.id, cloneValue(letter));
	}

	upsertClaim(claim: DiscourseClaim): void {
		this.claims.set(claim.id, cloneValue(claim));
	}

	upsertStamp(stamp: DiscourseStamp): void {
		this.stamps.set(stamp.id, cloneValue(stamp));
	}

	upsertRuntime(runtime: ChildAgentSummary): void {
		this.runtimes.set(runtime.id, cloneValue(runtime));
	}

	upsertKnowledgeAtom(atom: KnowledgeAtom): void {
		this.knowledgeAtoms.set(atom.id, cloneValue(atom));
	}

	upsertKnowledgeMolecule(molecule: KnowledgeMolecule): void {
		this.knowledgeMolecules.set(molecule.id, cloneValue(molecule));
	}

	upsertBudgetPolicy(policy: BudgetPolicy): void {
		this.budgetPolicies.set(policy.id, cloneValue(policy));
	}

	upsertBudgetLedger(entry: BudgetLedgerEntry): void {
		this.budgetLedger.set(entry.id, cloneValue(entry));
	}

	upsertAgentCapacity(capacity: AgentCapacity): void {
		this.agentCapacity = cloneValue(capacity);
	}

	insertComment(comment: ReviewComment): void {
		this.comments.set(comment.id, cloneValue(comment));
	}
}

const sharedInMemoryDrivers = new WeakMap<object, InMemoryDoltStoreDriver>();

export class DoltCliStoreDriver implements DoltStoreDriver {
	private initialized = false;

	constructor(private readonly repoPath: string) {}

	private run(args: string[]): string {
		const result = spawnSync("dolt", args, {
			cwd: this.repoPath,
			encoding: "utf-8",
		});
		if (result.error) {
			if ("code" in result.error && result.error.code === "ENOENT") {
				throw new Error(
					`Dolt CLI is required for Alef discourse storage but was not found. Install dolt and retry. Repo path: ${this.repoPath}`,
				);
			}
			throw result.error;
		}
		if (result.status !== 0) {
			throw new Error(result.stderr.trim() || `Dolt command failed: dolt ${args.join(" ")}`);
		}
		return result.stdout;
	}

	private ensureInitialized(): void {
		if (this.initialized) {
			return;
		}
		mkdirSync(this.repoPath, { recursive: true });
		if (!existsSync(join(this.repoPath, ".dolt"))) {
			this.run(["init", "--name", "Alef", "--email", "alef@local"]);
		}
		const schemaStatements = [
			`CREATE TABLE IF NOT EXISTS discourse_boards (
				id VARCHAR(191) PRIMARY KEY,
				key_name LONGTEXT NOT NULL,
				payload_json LONGTEXT NOT NULL,
				created_at BIGINT NOT NULL,
				updated_at BIGINT NOT NULL
			);`,
			`CREATE TABLE IF NOT EXISTS discourse_forums (
				id VARCHAR(191) PRIMARY KEY,
				board_id VARCHAR(191) NOT NULL,
				key_name LONGTEXT NOT NULL,
				payload_json LONGTEXT NOT NULL,
				created_at BIGINT NOT NULL,
				updated_at BIGINT NOT NULL
			);`,
			`CREATE TABLE IF NOT EXISTS discourse_route_affinities (
				id VARCHAR(191) PRIMARY KEY,
				binding_key LONGTEXT NOT NULL,
				payload_json LONGTEXT NOT NULL,
				updated_at BIGINT NOT NULL
			);`,
			`CREATE TABLE IF NOT EXISTS discourse_templates (
				id VARCHAR(191) PRIMARY KEY,
				key_name LONGTEXT NOT NULL,
				payload_json LONGTEXT NOT NULL,
				created_at BIGINT NOT NULL,
				updated_at BIGINT NOT NULL
			);`,
			`CREATE TABLE IF NOT EXISTS discourse_topics (
				id VARCHAR(191) PRIMARY KEY,
				key_name LONGTEXT NOT NULL,
				thread_id VARCHAR(191) NOT NULL,
				payload_json LONGTEXT NOT NULL,
				created_at BIGINT NOT NULL,
				updated_at BIGINT NOT NULL
			);`,
			`CREATE TABLE IF NOT EXISTS discourse_threads (
				id VARCHAR(191) PRIMARY KEY,
				topic_id VARCHAR(191) NOT NULL,
				key_name LONGTEXT NOT NULL,
				payload_json LONGTEXT NOT NULL,
				created_at BIGINT NOT NULL,
				updated_at BIGINT NOT NULL
			);`,
			`CREATE TABLE IF NOT EXISTS discourse_letters (
				id VARCHAR(191) PRIMARY KEY,
				thread_id VARCHAR(191) NOT NULL,
				topic_id VARCHAR(191) NOT NULL,
				payload_json LONGTEXT NOT NULL,
				created_at BIGINT NOT NULL
			);`,
			`CREATE TABLE IF NOT EXISTS discourse_claims (
				id VARCHAR(191) PRIMARY KEY,
				thread_id VARCHAR(191) NOT NULL,
				payload_json LONGTEXT NOT NULL,
				created_at BIGINT NOT NULL,
				updated_at BIGINT NOT NULL
			);`,
			`CREATE TABLE IF NOT EXISTS discourse_stamps (
				id VARCHAR(191) PRIMARY KEY,
				template_id VARCHAR(191) NOT NULL,
				payload_json LONGTEXT NOT NULL,
				requested_at BIGINT NOT NULL
			);`,
			`CREATE TABLE IF NOT EXISTS discourse_runtimes (
				id VARCHAR(191) PRIMARY KEY,
				topic_id LONGTEXT,
				payload_json LONGTEXT NOT NULL,
				created_at BIGINT NOT NULL,
				updated_at BIGINT NOT NULL
			);`,
			`CREATE TABLE IF NOT EXISTS knowledge_atoms (
				id VARCHAR(191) PRIMARY KEY,
				discourse_object_id LONGTEXT,
				runtime_id LONGTEXT,
				payload_json LONGTEXT NOT NULL,
				created_at BIGINT NOT NULL,
				updated_at BIGINT NOT NULL
			);`,
			`CREATE TABLE IF NOT EXISTS knowledge_molecules (
				id VARCHAR(191) PRIMARY KEY,
				discourse_object_id LONGTEXT,
				runtime_id LONGTEXT,
				payload_json LONGTEXT NOT NULL,
				created_at BIGINT NOT NULL,
				updated_at BIGINT NOT NULL
			);`,
			`CREATE TABLE IF NOT EXISTS budget_policies (
				id VARCHAR(191) PRIMARY KEY,
				scope_name LONGTEXT NOT NULL,
				target_id LONGTEXT,
				payload_json LONGTEXT NOT NULL,
				created_at BIGINT NOT NULL,
				updated_at BIGINT NOT NULL
			);`,
			`CREATE TABLE IF NOT EXISTS budget_ledgers (
				id VARCHAR(191) PRIMARY KEY,
				scope_name LONGTEXT NOT NULL,
				target_id LONGTEXT,
				window_name LONGTEXT NOT NULL,
				bucket_name LONGTEXT NOT NULL,
				payload_json LONGTEXT NOT NULL,
				updated_at BIGINT NOT NULL
			);`,
			`CREATE TABLE IF NOT EXISTS agent_capacity (
				id VARCHAR(191) PRIMARY KEY,
				payload_json LONGTEXT NOT NULL,
				updated_at BIGINT NOT NULL
			);`,
			`CREATE TABLE IF NOT EXISTS review_comments (
				id VARCHAR(191) PRIMARY KEY,
				document_id LONGTEXT NOT NULL,
				payload_json LONGTEXT NOT NULL,
				created_at BIGINT NOT NULL
			);`,
		];
		for (const statement of schemaStatements) {
			this.run(["sql", "-q", statement]);
		}
		this.initialized = true;
	}

	private queryRows(query: string): Record<string, unknown>[] {
		this.ensureInitialized();
		return parseJsonRows(this.run(["sql", "-r", "json", "-q", query]));
	}

	private execute(query: string): void {
		this.ensureInitialized();
		this.run(["sql", "-q", query]);
	}

	private loadPayloadCollection<T>(table: string, orderBy: string): T[] {
		return parsePayloadRows<T>(this.queryRows(`SELECT payload_json FROM ${table} ORDER BY ${orderBy} ASC;`));
	}

	loadSnapshot(): DoltStoreSnapshot {
		const capacity = parsePayloadRows<AgentCapacity>(
			this.queryRows("SELECT payload_json FROM agent_capacity ORDER BY updated_at DESC LIMIT 1;"),
		)[0];
		return {
			boards: this.loadPayloadCollection<DiscourseBoard>("discourse_boards", "created_at"),
			forums: this.loadPayloadCollection<DiscourseForum>("discourse_forums", "created_at"),
			routeAffinities: this.loadPayloadCollection<DiscourseRouteAffinity>(
				"discourse_route_affinities",
				"updated_at",
			),
			templates: this.loadPayloadCollection<DiscourseTemplate>("discourse_templates", "created_at"),
			topics: this.loadPayloadCollection<DiscourseTopic>("discourse_topics", "created_at"),
			threads: this.loadPayloadCollection<DiscourseThread>("discourse_threads", "created_at"),
			letters: this.loadPayloadCollection<DiscourseLetter>("discourse_letters", "created_at"),
			claims: this.loadPayloadCollection<DiscourseClaim>("discourse_claims", "created_at"),
			stamps: this.loadPayloadCollection<DiscourseStamp>("discourse_stamps", "requested_at"),
			runtimes: this.loadPayloadCollection<ChildAgentSummary>("discourse_runtimes", "created_at"),
			knowledgeAtoms: this.loadPayloadCollection<KnowledgeAtom>("knowledge_atoms", "created_at"),
			knowledgeMolecules: this.loadPayloadCollection<KnowledgeMolecule>("knowledge_molecules", "created_at"),
			budgetPolicies: this.loadPayloadCollection<BudgetPolicy>("budget_policies", "created_at"),
			budgetLedger: this.loadPayloadCollection<BudgetLedgerEntry>("budget_ledgers", "updated_at"),
			agentCapacity: capacity ? cloneValue(capacity) : undefined,
			comments: this.loadPayloadCollection<ReviewComment>("review_comments", "created_at"),
		};
	}

	upsertBoard(board: DiscourseBoard): void {
		this.execute(
			`REPLACE INTO discourse_boards (id, key_name, payload_json, created_at, updated_at) VALUES (${sqlLiteral(board.id)}, ${sqlLiteral(board.key)}, ${sqlJson(board)}, ${sqlLiteral(board.createdAt)}, ${sqlLiteral(board.updatedAt)});`,
		);
	}

	upsertForum(forum: DiscourseForum): void {
		this.execute(
			`REPLACE INTO discourse_forums (id, board_id, key_name, payload_json, created_at, updated_at) VALUES (${sqlLiteral(forum.id)}, ${sqlLiteral(forum.boardId)}, ${sqlLiteral(forum.key)}, ${sqlJson(forum)}, ${sqlLiteral(forum.createdAt)}, ${sqlLiteral(forum.updatedAt)});`,
		);
	}

	upsertRouteAffinity(affinity: DiscourseRouteAffinity): void {
		this.execute(
			`REPLACE INTO discourse_route_affinities (id, binding_key, payload_json, updated_at) VALUES (${sqlLiteral(affinity.id)}, ${sqlLiteral(affinity.bindingKey)}, ${sqlJson(affinity)}, ${sqlLiteral(affinity.updatedAt)});`,
		);
	}

	upsertTemplate(template: DiscourseTemplate): void {
		this.execute(
			`REPLACE INTO discourse_templates (id, key_name, payload_json, created_at, updated_at) VALUES (${sqlLiteral(template.id)}, ${sqlLiteral(template.key)}, ${sqlJson(template)}, ${sqlLiteral(template.createdAt)}, ${sqlLiteral(template.updatedAt)});`,
		);
	}

	upsertTopic(topic: DiscourseTopic): void {
		this.execute(
			`REPLACE INTO discourse_topics (id, key_name, thread_id, payload_json, created_at, updated_at) VALUES (${sqlLiteral(topic.id)}, ${sqlLiteral(topic.key)}, ${sqlLiteral(topic.threadId)}, ${sqlJson(topic)}, ${sqlLiteral(topic.createdAt)}, ${sqlLiteral(topic.updatedAt)});`,
		);
	}

	upsertThread(thread: DiscourseThread): void {
		this.execute(
			`REPLACE INTO discourse_threads (id, topic_id, key_name, payload_json, created_at, updated_at) VALUES (${sqlLiteral(thread.id)}, ${sqlLiteral(thread.topicId)}, ${sqlLiteral(thread.key)}, ${sqlJson(thread)}, ${sqlLiteral(thread.createdAt)}, ${sqlLiteral(thread.updatedAt)});`,
		);
	}

	insertLetter(letter: DiscourseLetter): void {
		this.execute(
			`REPLACE INTO discourse_letters (id, thread_id, topic_id, payload_json, created_at) VALUES (${sqlLiteral(letter.id)}, ${sqlLiteral(letter.threadId)}, ${sqlLiteral(letter.topicId)}, ${sqlJson(letter)}, ${sqlLiteral(letter.createdAt)});`,
		);
	}

	upsertClaim(claim: DiscourseClaim): void {
		this.execute(
			`REPLACE INTO discourse_claims (id, thread_id, payload_json, created_at, updated_at) VALUES (${sqlLiteral(claim.id)}, ${sqlLiteral(claim.threadId)}, ${sqlJson(claim)}, ${sqlLiteral(claim.createdAt)}, ${sqlLiteral(claim.updatedAt)});`,
		);
	}

	upsertStamp(stamp: DiscourseStamp): void {
		this.execute(
			`REPLACE INTO discourse_stamps (id, template_id, payload_json, requested_at) VALUES (${sqlLiteral(stamp.id)}, ${sqlLiteral(stamp.templateId)}, ${sqlJson(stamp)}, ${sqlLiteral(stamp.requestedAt)});`,
		);
	}

	upsertRuntime(runtime: ChildAgentSummary): void {
		this.execute(
			`REPLACE INTO discourse_runtimes (id, topic_id, payload_json, created_at, updated_at) VALUES (${sqlLiteral(runtime.id)}, ${sqlLiteral(runtime.topicId)}, ${sqlJson(runtime)}, ${sqlLiteral(runtime.createdAt)}, ${sqlLiteral(runtime.updatedAt)});`,
		);
	}

	upsertKnowledgeAtom(atom: KnowledgeAtom): void {
		this.execute(
			`REPLACE INTO knowledge_atoms (id, discourse_object_id, runtime_id, payload_json, created_at, updated_at) VALUES (${sqlLiteral(atom.id)}, ${sqlLiteral(atom.discourseObjectId)}, ${sqlLiteral(atom.runtimeId)}, ${sqlJson(atom)}, ${sqlLiteral(atom.createdAt)}, ${sqlLiteral(atom.updatedAt)});`,
		);
	}

	upsertKnowledgeMolecule(molecule: KnowledgeMolecule): void {
		this.execute(
			`REPLACE INTO knowledge_molecules (id, discourse_object_id, runtime_id, payload_json, created_at, updated_at) VALUES (${sqlLiteral(molecule.id)}, ${sqlLiteral(molecule.discourseObjectId)}, ${sqlLiteral(molecule.runtimeId)}, ${sqlJson(molecule)}, ${sqlLiteral(molecule.createdAt)}, ${sqlLiteral(molecule.updatedAt)});`,
		);
	}

	upsertBudgetPolicy(policy: BudgetPolicy): void {
		this.execute(
			`REPLACE INTO budget_policies (id, scope_name, target_id, payload_json, created_at, updated_at) VALUES (${sqlLiteral(policy.id)}, ${sqlLiteral(policy.scope)}, ${sqlLiteral(policy.targetId)}, ${sqlJson(policy)}, ${sqlLiteral(policy.createdAt)}, ${sqlLiteral(policy.updatedAt)});`,
		);
	}

	upsertBudgetLedger(entry: BudgetLedgerEntry): void {
		this.execute(
			`REPLACE INTO budget_ledgers (id, scope_name, target_id, window_name, bucket_name, payload_json, updated_at) VALUES (${sqlLiteral(entry.id)}, ${sqlLiteral(entry.scope)}, ${sqlLiteral(entry.targetId)}, ${sqlLiteral(entry.window)}, ${sqlLiteral(entry.bucket)}, ${sqlJson(entry)}, ${sqlLiteral(entry.updatedAt)});`,
		);
	}

	upsertAgentCapacity(capacity: AgentCapacity): void {
		this.execute(
			`REPLACE INTO agent_capacity (id, payload_json, updated_at) VALUES (${sqlLiteral(capacity.id)}, ${sqlJson(capacity)}, ${sqlLiteral(capacity.updatedAt)});`,
		);
	}

	insertComment(comment: ReviewComment): void {
		this.execute(
			`REPLACE INTO review_comments (id, document_id, payload_json, created_at) VALUES (${sqlLiteral(comment.id)}, ${sqlLiteral(comment.documentId)}, ${sqlJson(comment)}, ${sqlLiteral(comment.createdAt)});`,
		);
	}
}

function isDoltCliAvailable(): boolean {
	const result = spawnSync("dolt", ["version"], { stdio: "ignore", timeout: 2000 });
	return result.status === 0;
}

export function shouldUseInMemoryDoltDriver(): boolean {
	if (
		process.env.VITEST === "true" ||
		process.env.VITEST === "1" ||
		process.env.NODE_ENV === "test" ||
		process.env.ALEF_DISCOURSE_DRIVER === "memory"
	) {
		return true;
	}
	// Fall back to in-memory driver when dolt CLI is not installed.
	// This avoids a hard crash at startup; discourse persistence is simply disabled.
	if (!isDoltCliAvailable()) {
		return true;
	}
	return false;
}

export function getDefaultDoltRepoPath(sessionManager: Pick<SessionManagerLike, "getSessionDir">): string {
	return join(sessionManager.getSessionDir(), "dolt-discourse");
}

export function createDefaultDoltStoreDriver(
	sessionManager: Pick<SessionManagerLike, "getSessionDir">,
): DoltStoreDriver {
	const repoPath = getDefaultDoltRepoPath(sessionManager);
	if (shouldUseInMemoryDoltDriver()) {
		const cacheKey = sessionManager as object;
		const existing = sharedInMemoryDrivers.get(cacheKey);
		if (existing) {
			return existing;
		}
		const driver = new InMemoryDoltStoreDriver();
		sharedInMemoryDrivers.set(cacheKey, driver);
		return driver;
	}
	return new DoltCliStoreDriver(repoPath);
}
