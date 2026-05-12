import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { type BoardPath, boardPathToAddress, parseBoardAddress } from "@dpopsuev/alef-agent-runtime/board";
import type { SessionManager } from "../session-manager.js";
import { createDefaultDoltStoreDriver, type DoltStoreDriver } from "./dolt-store.js";
import type {
	AgentCapacity,
	AgentDiscoursePort,
	ApproveDiscourseContractRequest,
	ApproveDiscourseTemplateRequest,
	ArchiveDiscourseTopicRequest,
	AssignDiscourseTopicRequest,
	BlackboardTopicSummary,
	BudgetLedgerEntry,
	BudgetPolicy,
	BudgetStatusSnapshot,
	BudgetThresholdAction,
	BudgetWindow,
	ChildAgentSummary,
	ClaimDiscourseTargetRequest,
	CreateDiscourseContractRequest,
	CreateDiscourseTemplateRequest,
	CreateDiscourseTopicRequest,
	CreateKnowledgeAtomRequest,
	CreateKnowledgeMoleculeRequest,
	DecideDiscourseStampRequest,
	DiscourseAddress,
	DiscourseBoard,
	DiscourseClaim,
	DiscourseContract,
	DiscourseForum,
	DiscourseLabel,
	DiscourseLabelSource,
	DiscourseLetter,
	DiscourseRouteAffinity,
	DiscourseStamp,
	DiscourseTemplate,
	DiscourseThread,
	DiscourseThreadView,
	DiscourseTopic,
	EnsureDiscourseBoardRequest,
	EnsureDiscourseForumRequest,
	KnowledgeAtom,
	KnowledgeMolecule,
	ListKnowledgeArtifactsRequest,
	PostDiscourseLetterRequest,
	PostOperatorDiscourseLetterRequest,
	ReadBudgetStatusRequest,
	ReadDiscourseThreadRequest,
	RecordBudgetUsageRequest,
	ReleaseDiscourseClaimRequest,
	RelocateDiscourseTopicRequest,
	RenewDiscourseClaimRequest,
	RequestDiscourseStampRequest,
	SetAgentCapacityRequest,
	UpdateDiscourseTopicRequest,
	UpdateRuntimeRequest,
	UpsertBudgetPolicyRequest,
} from "./types.js";

export const DISCOURSE_CUSTOM_ENTRY_TYPE = "alef.platform.discourse";

type LabelInput = {
	key: string;
	value?: string;
	source?: DiscourseLabelSource;
};

const DEFAULT_AGENT_CAPACITY = 4;

function cloneValue<T>(value: T): T {
	return structuredClone(value);
}

function requireNonEmpty(value: string, message: string): string {
	const normalized = value.trim();
	if (normalized.length === 0) {
		throw new Error(message);
	}
	return normalized;
}

function slugify(value: string): string {
	return (
		value
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "general"
	);
}

function titleize(value: string): string {
	return value
		.split(/[-_]+/g)
		.filter(Boolean)
		.map((part) => part[0]?.toUpperCase() + part.slice(1))
		.join(" ");
}

function normalizeAddress(address: string | DiscourseAddress): DiscourseAddress {
	return typeof address === "string" ? parseBoardAddress(address) : cloneValue(address);
}

function normalizeSegment(value: string | undefined, fallback: string): string {
	if (!value?.trim()) {
		return fallback;
	}
	return slugify(value);
}

function normalizeLabelKey(value: string): string {
	return slugify(requireNonEmpty(value, "Label key cannot be empty."));
}

function normalizeLabelValue(value: string | undefined): string | undefined {
	return value?.trim() ? slugify(value) : undefined;
}

function labelSelector(label: Pick<DiscourseLabel, "key" | "value">): string {
	return label.value ? `${label.key}:${label.value}` : label.key;
}

function buildLabels(
	inputs: ReadonlyArray<LabelInput> | undefined,
	fallbackSource: DiscourseLabelSource,
	existing: ReadonlyArray<DiscourseLabel> = [],
): DiscourseLabel[] {
	const merged = new Map<string, DiscourseLabel>();
	for (const label of existing) {
		merged.set(labelSelector(label), cloneValue(label));
	}
	for (const input of inputs ?? []) {
		const key = normalizeLabelKey(input.key);
		const value = normalizeLabelValue(input.value);
		const selector = value ? `${key}:${value}` : key;
		const current = merged.get(selector);
		if (current) {
			continue;
		}
		merged.set(selector, {
			id: randomUUID(),
			key,
			value,
			source: input.source ?? fallbackSource,
			createdAt: Date.now(),
		});
	}
	return Array.from(merged.values());
}

function latestByTime<T extends { decidedAt?: number; requestedAt?: number; createdAt?: number }>(
	values: ReadonlyArray<T>,
): T | undefined {
	return [...values].sort(
		(a, b) => (a.decidedAt ?? a.requestedAt ?? a.createdAt ?? 0) - (b.decidedAt ?? b.requestedAt ?? b.createdAt ?? 0),
	)[values.length - 1];
}

function startOfUtcDay(timestamp: number): number {
	const date = new Date(timestamp);
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function startOfUtcMonth(timestamp: number): number {
	const date = new Date(timestamp);
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function startOfUtcIsoWeek(timestamp: number): number {
	const date = new Date(startOfUtcDay(timestamp));
	const day = date.getUTCDay() || 7;
	date.setUTCDate(date.getUTCDate() - day + 1);
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function getBudgetBucket(window: BudgetWindow, timestamp: number): { bucket: string; bucketStart: number } {
	const bucketStart =
		window === "day"
			? startOfUtcDay(timestamp)
			: window === "week"
				? startOfUtcIsoWeek(timestamp)
				: startOfUtcMonth(timestamp);
	return {
		bucket: `${window}:${new Date(bucketStart).toISOString().slice(0, 10)}`,
		bucketStart,
	};
}

function budgetActionRank(action: BudgetThresholdAction | undefined): number {
	switch (action) {
		case "abort":
			return 4;
		case "throttle":
			return 3;
		case "warn":
			return 2;
		case "inform":
			return 1;
		default:
			return 0;
	}
}

function determineBudgetAction(
	policy: BudgetPolicy[BudgetWindow],
	usedTokens: number,
): BudgetThresholdAction | undefined {
	if (!policy) {
		return undefined;
	}
	const informAt = policy.informAt ?? Math.max(1, Math.floor(policy.maxTokens * 0.5));
	const warnAt = policy.warnAt ?? Math.max(informAt, Math.floor(policy.maxTokens * 0.8));
	const throttleAt = policy.throttleAt ?? Math.max(warnAt, Math.floor(policy.maxTokens * 0.95));
	const abortAt = policy.abortAt ?? policy.maxTokens;
	if (usedTokens >= abortAt) {
		return "abort";
	}
	if (usedTokens >= throttleAt) {
		return "throttle";
	}
	if (usedTokens >= warnAt) {
		return "warn";
	}
	if (usedTokens >= informAt) {
		return "inform";
	}
	return undefined;
}

function currentStatusForLifecycle(
	status: DiscourseTopic["status"],
	lifecycle: DiscourseTopic["lifecycle"],
): DiscourseTopic["status"] {
	if (status === "resolved" || status === "cancelled") {
		return status;
	}
	if (lifecycle === "running") {
		return "running";
	}
	if (lifecycle === "archived") {
		return "resolved";
	}
	if (lifecycle === "idle" || lifecycle === "sleep") {
		return "assigned";
	}
	return status;
}

export class DoltBackedDiscourseStore implements AgentDiscoursePort {
	private readonly boards = new Map<string, DiscourseBoard>();
	private readonly boardIdsByKey = new Map<string, string>();
	private readonly forums = new Map<string, DiscourseForum>();
	private readonly forumIdsByBoardAndKey = new Map<string, string>();
	private readonly routeAffinitiesByBinding = new Map<string, DiscourseRouteAffinity>();
	private readonly templates = new Map<string, DiscourseTemplate>();
	private readonly topics = new Map<string, DiscourseTopic>();
	private readonly threads = new Map<string, DiscourseThread>();
	private readonly topicIdsByAddress = new Map<string, string>();
	private readonly threadIdsByAddress = new Map<string, string>();
	private readonly lettersByThread = new Map<string, DiscourseLetter[]>();
	private readonly claims = new Map<string, DiscourseClaim>();
	private readonly stamps = new Map<string, DiscourseStamp>();
	private readonly runtimes = new Map<string, ChildAgentSummary>();
	private readonly knowledgeAtoms = new Map<string, KnowledgeAtom>();
	private readonly knowledgeMolecules = new Map<string, KnowledgeMolecule>();
	private readonly budgetPolicies = new Map<string, BudgetPolicy>();
	private readonly budgetLedger = new Map<string, BudgetLedgerEntry>();
	private readonly budgetLedgerIdsByKey = new Map<string, string>();
	private agentCapacity: AgentCapacity = {
		id: "global",
		maxConcurrent: DEFAULT_AGENT_CAPACITY,
		activeRuntimeIds: [],
		updatedAt: Date.now(),
	};
	private hydrated = false;
	private readonly defaultBoardKey: string;

	constructor(
		private readonly sessionManager: SessionManager,
		private readonly driver: DoltStoreDriver = createDefaultDoltStoreDriver(sessionManager),
	) {
		this.defaultBoardKey = normalizeSegment(basename(sessionManager.getCwd()), "discourse");
	}

	private forumLookupKey(boardId: string, key: string): string {
		return `${boardId}:${key}`;
	}

	private budgetLedgerLookupKey(
		scope: BudgetLedgerEntry["scope"],
		targetId: string | undefined,
		window: BudgetWindow,
		bucket: string,
	): string {
		return `${scope}:${targetId ?? "*"}:${window}:${bucket}`;
	}

	private ensureHydrated(): void {
		if (this.hydrated) {
			return;
		}
		this.hydrate(this.driver.loadSnapshot());
		this.hydrated = true;
	}

	private hydrate(snapshot: ReturnType<DoltStoreDriver["loadSnapshot"]>): void {
		this.boards.clear();
		this.boardIdsByKey.clear();
		this.forums.clear();
		this.forumIdsByBoardAndKey.clear();
		this.routeAffinitiesByBinding.clear();
		this.templates.clear();
		this.topics.clear();
		this.threads.clear();
		this.topicIdsByAddress.clear();
		this.threadIdsByAddress.clear();
		this.lettersByThread.clear();
		this.claims.clear();
		this.stamps.clear();
		this.runtimes.clear();
		this.knowledgeAtoms.clear();
		this.knowledgeMolecules.clear();
		this.budgetPolicies.clear();
		this.budgetLedger.clear();
		this.budgetLedgerIdsByKey.clear();

		for (const board of snapshot.boards) {
			this.indexBoard(board);
		}
		for (const forum of snapshot.forums) {
			this.indexForum(forum);
		}
		for (const affinity of snapshot.routeAffinities) {
			this.indexRouteAffinity(affinity);
		}
		for (const template of snapshot.templates) {
			this.templates.set(template.id, cloneValue(template));
		}
		for (const topic of snapshot.topics) {
			this.indexTopic(topic);
		}
		for (const thread of snapshot.threads) {
			this.indexThread(thread);
		}
		for (const letter of snapshot.letters) {
			this.indexLetter(letter);
		}
		for (const claim of snapshot.claims) {
			this.claims.set(claim.id, cloneValue(claim));
		}
		for (const stamp of snapshot.stamps) {
			this.stamps.set(stamp.id, cloneValue(stamp));
		}
		for (const runtime of snapshot.runtimes) {
			this.runtimes.set(runtime.id, cloneValue(runtime));
		}
		for (const atom of snapshot.knowledgeAtoms) {
			this.knowledgeAtoms.set(atom.id, cloneValue(atom));
		}
		for (const molecule of snapshot.knowledgeMolecules) {
			this.knowledgeMolecules.set(molecule.id, cloneValue(molecule));
		}
		for (const policy of snapshot.budgetPolicies) {
			this.budgetPolicies.set(policy.id, cloneValue(policy));
		}
		for (const entry of snapshot.budgetLedger) {
			this.indexBudgetLedger(entry);
		}
		if (snapshot.agentCapacity) {
			this.agentCapacity = cloneValue(snapshot.agentCapacity);
		}
	}

	private indexBoard(board: DiscourseBoard): void {
		const cloned = cloneValue(board);
		this.boards.set(cloned.id, cloned);
		this.boardIdsByKey.set(cloned.key, cloned.id);
	}

	private indexForum(forum: DiscourseForum): void {
		const cloned = cloneValue(forum);
		this.forums.set(cloned.id, cloned);
		this.forumIdsByBoardAndKey.set(this.forumLookupKey(cloned.boardId, cloned.key), cloned.id);
	}

	private indexRouteAffinity(affinity: DiscourseRouteAffinity): void {
		this.routeAffinitiesByBinding.set(affinity.bindingKey, cloneValue(affinity));
	}

	private indexTopic(topic: DiscourseTopic): void {
		const cloned = cloneValue(topic);
		this.topics.set(cloned.id, cloned);
		this.topicIdsByAddress.set(boardPathToAddress(cloned.address), cloned.id);
	}

	private indexThread(thread: DiscourseThread): void {
		const cloned = cloneValue(thread);
		this.threads.set(cloned.id, cloned);
		this.threadIdsByAddress.set(boardPathToAddress(cloned.address), cloned.id);
	}

	private indexLetter(letter: DiscourseLetter): void {
		const cloned = cloneValue(letter);
		const letters = this.lettersByThread.get(cloned.threadId) ?? [];
		letters.push(cloned);
		letters.sort((a, b) => a.createdAt - b.createdAt);
		this.lettersByThread.set(cloned.threadId, letters);
	}

	private indexBudgetLedger(entry: BudgetLedgerEntry): void {
		const cloned = cloneValue(entry);
		this.budgetLedger.set(cloned.id, cloned);
		this.budgetLedgerIdsByKey.set(
			this.budgetLedgerLookupKey(cloned.scope, cloned.targetId, cloned.window, cloned.bucket),
			cloned.id,
		);
	}

	private defaultBoardMetadata(): Record<string, unknown> {
		return {
			cwd: this.sessionManager.getCwd(),
			sessionId: this.sessionManager.getSessionId(),
		};
	}

	private getBoardRecord(boardIdOrKey?: string, boardKey?: string): DiscourseBoard | undefined {
		this.ensureHydrated();
		if (boardIdOrKey?.trim()) {
			const byId = this.boards.get(boardIdOrKey.trim());
			if (byId) {
				return byId;
			}
			const normalizedKey = normalizeSegment(boardIdOrKey, this.defaultBoardKey);
			const mappedId = this.boardIdsByKey.get(normalizedKey);
			if (mappedId) {
				return this.boards.get(mappedId);
			}
		}
		if (boardKey?.trim()) {
			const normalizedKey = normalizeSegment(boardKey, this.defaultBoardKey);
			const mappedId = this.boardIdsByKey.get(normalizedKey);
			if (mappedId) {
				return this.boards.get(mappedId);
			}
		}
		if (!boardIdOrKey?.trim() && !boardKey?.trim()) {
			const defaultBoardId = this.boardIdsByKey.get(this.defaultBoardKey);
			if (defaultBoardId) {
				return this.boards.get(defaultBoardId);
			}
		}
		return undefined;
	}

	private requireBoard(boardId: string): DiscourseBoard {
		const board = this.getBoardRecord(boardId);
		if (!board) {
			throw new Error(`Unknown board: ${boardId}`);
		}
		return board;
	}

	private getForumRecord(boardId: string, forumIdOrKey?: string, forumKey?: string): DiscourseForum | undefined {
		this.ensureHydrated();
		if (forumIdOrKey?.trim()) {
			const byId = this.forums.get(forumIdOrKey.trim());
			if (byId && byId.boardId === boardId) {
				return byId;
			}
			const normalizedKey = normalizeSegment(forumIdOrKey, "general");
			const mappedId = this.forumIdsByBoardAndKey.get(this.forumLookupKey(boardId, normalizedKey));
			if (mappedId) {
				return this.forums.get(mappedId);
			}
		}
		if (forumKey?.trim()) {
			const normalizedKey = normalizeSegment(forumKey, "general");
			const mappedId = this.forumIdsByBoardAndKey.get(this.forumLookupKey(boardId, normalizedKey));
			if (mappedId) {
				return this.forums.get(mappedId);
			}
		}
		return undefined;
	}

	private requireForum(forumId: string): DiscourseForum {
		this.ensureHydrated();
		const forum = this.forums.get(forumId);
		if (!forum) {
			throw new Error(`Unknown forum: ${forumId}`);
		}
		return forum;
	}

	private requireTemplate(templateId: string): DiscourseTemplate {
		this.ensureHydrated();
		const template = this.templates.get(templateId);
		if (!template) {
			throw new Error(`Unknown template: ${templateId}`);
		}
		return template;
	}

	private requireTopic(topicId: string): DiscourseTopic {
		this.ensureHydrated();
		const topic = this.topics.get(topicId);
		if (!topic) {
			throw new Error(`Unknown topic: ${topicId}`);
		}
		return topic;
	}

	private requireThread(threadId: string): DiscourseThread {
		this.ensureHydrated();
		const thread = this.threads.get(threadId);
		if (!thread) {
			throw new Error(`Unknown thread: ${threadId}`);
		}
		return thread;
	}

	private requireClaim(claimId: string): DiscourseClaim {
		this.ensureHydrated();
		const claim = this.claims.get(claimId);
		if (!claim) {
			throw new Error(`Unknown claim: ${claimId}`);
		}
		return claim;
	}

	private requireStamp(stampId: string): DiscourseStamp {
		this.ensureHydrated();
		const stamp = this.stamps.get(stampId);
		if (!stamp) {
			throw new Error(`Unknown stamp: ${stampId}`);
		}
		return stamp;
	}

	private requireRuntime(runtimeId: string): ChildAgentSummary {
		this.ensureHydrated();
		const runtime = this.runtimes.get(runtimeId);
		if (!runtime) {
			throw new Error(`Unknown runtime: ${runtimeId}`);
		}
		return runtime;
	}

	private getBoardForThread(thread: DiscourseThread): DiscourseBoard | undefined {
		return this.boards.get(thread.boardId);
	}

	private getForumForThread(thread: DiscourseThread): DiscourseForum | undefined {
		return this.forums.get(thread.forumId);
	}

	private getTemplateForTopic(topic: DiscourseTopic): DiscourseTemplate | undefined {
		const template = topic.templateId
			? this.templates.get(topic.templateId)
			: topic.satisfiesTemplateId
				? this.templates.get(topic.satisfiesTemplateId)
				: topic.contractId
					? this.templates.get(topic.contractId)
					: undefined;
		return template ? this.cloneTemplate(template) : undefined;
	}

	private cloneTemplate(template: DiscourseTemplate): DiscourseTemplate {
		const cloned = cloneValue(template);
		const latestDecision = latestByTime(
			Array.from(this.stamps.values()).filter(
				(stamp) => stamp.templateId === template.id && stamp.decision !== "pending",
			),
		);
		if (latestDecision?.decision === "approved") {
			cloned.status =
				template.status === "active" || template.status === "completed" || template.status === "cancelled"
					? template.status
					: "approved";
			cloned.approvedBy = latestDecision.decidedBy ?? cloned.approvedBy;
		} else if (latestDecision?.decision === "rejected") {
			cloned.status = "rejected";
		}
		return cloned;
	}

	private getLatestLetter(threadId: string): DiscourseLetter | undefined {
		const letters = this.lettersByThread.get(threadId);
		return letters && letters.length > 0 ? cloneValue(letters[letters.length - 1]) : undefined;
	}

	private getClaimsForThread(thread: DiscourseThread): DiscourseClaim[] {
		this.expireClaims();
		return Array.from(this.claims.values())
			.filter((claim) => claim.threadId === thread.id && claim.status === "active")
			.sort((a, b) => a.createdAt - b.createdAt)
			.map((claim) => cloneValue(claim));
	}

	private getStampsForTemplate(templateId: string | undefined): DiscourseStamp[] {
		if (!templateId) {
			return [];
		}
		return Array.from(this.stamps.values())
			.filter((stamp) => stamp.templateId === templateId)
			.sort((a, b) => a.requestedAt - b.requestedAt)
			.map((stamp) => cloneValue(stamp));
	}

	private getRuntimesForTopic(topicId: string): ChildAgentSummary[] {
		return Array.from(this.runtimes.values())
			.filter((runtime) => runtime.topicId === topicId)
			.sort((a, b) => a.createdAt - b.createdAt)
			.map((runtime) => cloneValue(runtime));
	}

	private getAtomsForTopic(topicId: string, threadId: string): KnowledgeAtom[] {
		return Array.from(this.knowledgeAtoms.values())
			.filter((atom) => atom.topicId === topicId || atom.threadId === threadId || atom.discourseObjectId === topicId)
			.sort((a, b) => a.createdAt - b.createdAt)
			.map((atom) => cloneValue(atom));
	}

	private getMoleculesForTopic(topicId: string, threadId: string): KnowledgeMolecule[] {
		return Array.from(this.knowledgeMolecules.values())
			.filter(
				(molecule) =>
					molecule.topicId === topicId || molecule.threadId === threadId || molecule.discourseObjectId === topicId,
			)
			.sort((a, b) => a.createdAt - b.createdAt)
			.map((molecule) => cloneValue(molecule));
	}

	private uniqueTopicKey(boardKey: string, forumKey: string, proposed: string, currentTopicId?: string): string {
		let key = normalizeSegment(proposed, "topic");
		let attempt = 2;
		while (true) {
			const address = boardPathToAddress({ boardId: boardKey, forumId: forumKey, topicId: key });
			const existingTopicId = this.topicIdsByAddress.get(address);
			if (!existingTopicId || existingTopicId === currentTopicId) {
				return key;
			}
			key = `${normalizeSegment(proposed, "topic")}-${attempt++}`;
		}
	}

	private uniqueThreadKey(
		boardKey: string,
		forumKey: string,
		topicKey: string,
		proposed: string,
		currentThreadId?: string,
	): string {
		let key = normalizeSegment(proposed, "thread");
		let attempt = 2;
		while (true) {
			const address = boardPathToAddress({ boardId: boardKey, forumId: forumKey, topicId: topicKey, threadId: key });
			const existingThreadId = this.threadIdsByAddress.get(address);
			if (!existingThreadId || existingThreadId === currentThreadId) {
				return key;
			}
			key = `${normalizeSegment(proposed, "thread")}-${attempt++}`;
		}
	}

	private entityLabels(
		board: DiscourseBoard,
		forum: DiscourseForum,
		options: {
			routingState?: string;
			templateId?: string;
			extra?: ReadonlyArray<LabelInput>;
			fallbackSource?: DiscourseLabelSource;
			existing?: ReadonlyArray<DiscourseLabel>;
		} = {},
	): DiscourseLabel[] {
		return buildLabels(
			[
				{ key: "board", value: board.key, source: "system" },
				{ key: "forum", value: forum.key, source: "system" },
				options.routingState ? { key: "routing", value: options.routingState, source: "system" } : undefined,
				options.templateId ? { key: "template", value: options.templateId, source: "system" } : undefined,
				...(options.extra ?? []),
			].filter((value): value is LabelInput => value !== undefined),
			options.fallbackSource ?? "system",
			options.existing ?? [],
		);
	}

	private selectorSetForThread(topic: DiscourseTopic, thread: DiscourseThread): Set<string> {
		const selectors = new Set<string>();
		const board = this.requireBoard(topic.boardId);
		const forum = this.requireForum(topic.forumId);
		for (const label of [...topic.labels, ...thread.labels]) {
			selectors.add(labelSelector(label));
		}
		selectors.add(`board:${board.key}`);
		selectors.add(`forum:${forum.key}`);
		selectors.add(`routing:${topic.routingState}`);
		selectors.add(`address:${boardPathToAddress(thread.address)}`);
		if (topic.templateId) {
			selectors.add(`template:${topic.templateId}`);
		}
		if (topic.satisfiesTemplateId) {
			selectors.add(`template:${topic.satisfiesTemplateId}`);
		}
		if (topic.contractId) {
			selectors.add(`contract:${topic.contractId}`);
		}
		return selectors;
	}

	private upsertBoard(board: DiscourseBoard): void {
		const previous = this.boards.get(board.id);
		if (previous) {
			this.boardIdsByKey.delete(previous.key);
		}
		this.indexBoard(board);
		this.driver.upsertBoard(board);
	}

	private upsertForum(forum: DiscourseForum): void {
		const previous = this.forums.get(forum.id);
		if (previous) {
			this.forumIdsByBoardAndKey.delete(this.forumLookupKey(previous.boardId, previous.key));
		}
		this.indexForum(forum);
		this.driver.upsertForum(forum);
	}

	private upsertRouteAffinity(affinity: DiscourseRouteAffinity): void {
		this.indexRouteAffinity(affinity);
		this.driver.upsertRouteAffinity(affinity);
	}

	private upsertTemplate(template: DiscourseTemplate): void {
		this.templates.set(template.id, cloneValue(template));
		this.driver.upsertTemplate(template);
	}

	private upsertTopic(topic: DiscourseTopic): void {
		const previous = this.topics.get(topic.id);
		if (previous) {
			this.topicIdsByAddress.delete(boardPathToAddress(previous.address));
		}
		this.indexTopic(topic);
		this.driver.upsertTopic(topic);
	}

	private upsertThread(thread: DiscourseThread): void {
		const previous = this.threads.get(thread.id);
		if (previous) {
			this.threadIdsByAddress.delete(boardPathToAddress(previous.address));
		}
		this.indexThread(thread);
		this.driver.upsertThread(thread);
	}

	private insertLetter(letter: DiscourseLetter): void {
		this.indexLetter(letter);
		this.driver.insertLetter(letter);
	}

	private replaceThreadLetters(threadId: string, letters: DiscourseLetter[]): void {
		const clonedLetters = letters.map((letter) => cloneValue(letter));
		this.lettersByThread.set(threadId, clonedLetters);
		for (const letter of clonedLetters) {
			this.driver.insertLetter(letter);
		}
	}

	private upsertClaim(claim: DiscourseClaim): void {
		this.claims.set(claim.id, cloneValue(claim));
		this.driver.upsertClaim(claim);
	}

	private upsertStamp(stamp: DiscourseStamp): void {
		this.stamps.set(stamp.id, cloneValue(stamp));
		this.driver.upsertStamp(stamp);
	}

	private upsertRuntimeRecord(runtime: ChildAgentSummary): void {
		this.runtimes.set(runtime.id, cloneValue(runtime));
		this.driver.upsertRuntime(runtime);
	}

	private upsertKnowledgeAtomRecord(atom: KnowledgeAtom): void {
		this.knowledgeAtoms.set(atom.id, cloneValue(atom));
		this.driver.upsertKnowledgeAtom(atom);
	}

	private upsertKnowledgeMoleculeRecord(molecule: KnowledgeMolecule): void {
		this.knowledgeMolecules.set(molecule.id, cloneValue(molecule));
		this.driver.upsertKnowledgeMolecule(molecule);
	}

	private upsertBudgetPolicyRecord(policy: BudgetPolicy): void {
		this.budgetPolicies.set(policy.id, cloneValue(policy));
		this.driver.upsertBudgetPolicy(policy);
	}

	private upsertBudgetLedgerRecord(entry: BudgetLedgerEntry): void {
		const previous = this.budgetLedger.get(entry.id);
		if (previous) {
			this.budgetLedgerIdsByKey.delete(
				this.budgetLedgerLookupKey(previous.scope, previous.targetId, previous.window, previous.bucket),
			);
		}
		this.indexBudgetLedger(entry);
		this.driver.upsertBudgetLedger(entry);
	}

	private currentCapacityRuntimeIds(): string[] {
		return Array.from(this.runtimes.values())
			.filter((runtime) => runtime.status !== "archived" && runtime.status !== "error")
			.map((runtime) => runtime.id)
			.sort();
	}

	private persistAgentCapacity(): void {
		this.agentCapacity = {
			...this.agentCapacity,
			activeRuntimeIds: this.currentCapacityRuntimeIds(),
			updatedAt: Date.now(),
		};
		this.driver.upsertAgentCapacity(this.agentCapacity);
	}

	private syncTopicLifecycle(topicId: string): void {
		const topic = this.topics.get(topicId);
		if (!topic) {
			return;
		}
		const thread = this.threads.get(topic.threadId);
		if (!thread) {
			return;
		}
		const runtimes = Array.from(this.runtimes.values()).filter((runtime) => runtime.topicId === topicId);
		let lifecycle = topic.lifecycle;
		if (runtimes.length > 0) {
			if (runtimes.some((runtime) => runtime.status === "draining")) {
				lifecycle = "draining";
			} else if (runtimes.some((runtime) => runtime.status === "running")) {
				lifecycle = "running";
			} else if (runtimes.some((runtime) => runtime.status === "error")) {
				lifecycle = "error";
			} else if (runtimes.some((runtime) => runtime.status === "sleep")) {
				lifecycle = "sleep";
			} else if (runtimes.some((runtime) => runtime.status === "idle")) {
				lifecycle = "idle";
			} else if (runtimes.some((runtime) => runtime.status === "waiting")) {
				lifecycle = "waiting";
			} else if (runtimes.every((runtime) => runtime.status === "archived")) {
				lifecycle = "archived";
			}
		}
		const assignedRuntime = [...runtimes].sort((a, b) => a.updatedAt - b.updatedAt)[runtimes.length - 1];
		const updatedAt = Math.max(topic.updatedAt, thread.updatedAt, assignedRuntime?.updatedAt ?? 0, Date.now());
		this.upsertTopic({
			...topic,
			lifecycle,
			status: currentStatusForLifecycle(topic.status, lifecycle),
			assignedAgentId: assignedRuntime?.id ?? topic.assignedAgentId,
			updatedAt,
		});
		this.upsertThread({
			...thread,
			lifecycle,
			status: lifecycle === "archived" ? "closed" : thread.status,
			updatedAt,
		});
		this.persistAgentCapacity();
	}

	private applicableBudgetPolicies(agentId?: string, discourseObjectId?: string): BudgetPolicy[] {
		return Array.from(this.budgetPolicies.values())
			.filter((policy) => {
				if (!policy.enabled) {
					return false;
				}
				if (policy.scope === "global") {
					return !policy.targetId;
				}
				if (policy.scope === "agent") {
					return Boolean(agentId) && policy.targetId === agentId;
				}
				return Boolean(discourseObjectId) && policy.targetId === discourseObjectId;
			})
			.sort((a, b) => a.createdAt - b.createdAt);
	}

	private findBudgetLedger(
		scope: BudgetLedgerEntry["scope"],
		targetId: string | undefined,
		window: BudgetWindow,
		bucket: string,
	): BudgetLedgerEntry | undefined {
		const ledgerId = this.budgetLedgerIdsByKey.get(this.budgetLedgerLookupKey(scope, targetId, window, bucket));
		return ledgerId ? this.budgetLedger.get(ledgerId) : undefined;
	}

	private buildBudgetSnapshots(
		agentId: string | undefined,
		discourseObjectId: string | undefined,
		at: number,
	): BudgetStatusSnapshot[] {
		const snapshots = new Map<string, BudgetStatusSnapshot>();
		for (const policy of this.applicableBudgetPolicies(agentId, discourseObjectId)) {
			for (const window of ["day", "week", "month"] as const) {
				const windowPolicy = policy[window];
				if (!windowPolicy) {
					continue;
				}
				const { bucket } = getBudgetBucket(window, at);
				const ledger = this.findBudgetLedger(policy.scope, policy.targetId, window, bucket);
				const usedTokens = ledger?.totalTokens ?? 0;
				const action = determineBudgetAction(windowPolicy, usedTokens);
				const snapshot: BudgetStatusSnapshot = {
					scope: policy.scope,
					targetId: policy.targetId,
					window,
					bucket,
					maxTokens: windowPolicy.maxTokens,
					usedTokens,
					remainingTokens: Math.max(0, windowPolicy.maxTokens - usedTokens),
					action,
					throttled: action === "throttle" || action === "abort",
					blocked: action === "abort",
				};
				snapshots.set(`${snapshot.scope}:${snapshot.targetId ?? "*"}:${window}:${bucket}`, snapshot);
			}
		}
		return Array.from(snapshots.values()).sort((a, b) => budgetActionRank(b.action) - budgetActionRank(a.action));
	}

	private buildTopicSummary(topic: DiscourseTopic): BlackboardTopicSummary {
		const thread = this.requireThread(topic.threadId);
		const template = this.getTemplateForTopic(topic);
		const board = this.getBoardForThread(thread);
		const forum = this.getForumForThread(thread);
		return {
			board: board ? cloneValue(board) : undefined,
			forum: forum ? cloneValue(forum) : undefined,
			template: template ? cloneValue(template) : undefined,
			contract: template ? cloneValue(template) : undefined,
			topic: cloneValue(topic),
			thread: cloneValue(thread),
			latestLetter: this.getLatestLetter(thread.id),
			activeClaims: this.getClaimsForThread(thread),
			stamps: this.getStampsForTemplate(template?.id),
		};
	}

	private resolveClaimTarget(request: ClaimDiscourseTargetRequest): {
		topic: DiscourseTopic;
		thread: DiscourseThread;
	} {
		if (request.targetAddress) {
			const thread = this.getThreadByAddress(request.targetAddress);
			if (!thread) {
				throw new Error(`Unknown discourse address: ${request.targetAddress}`);
			}
			return { thread, topic: this.requireTopic(thread.topicId) };
		}
		if (request.threadId?.trim()) {
			const thread = this.requireThread(request.threadId.trim());
			return { thread, topic: this.requireTopic(thread.topicId) };
		}
		if (request.topicId?.trim()) {
			const topic = this.requireTopic(request.topicId.trim());
			return { topic, thread: this.requireThread(topic.threadId) };
		}
		const selectors = (request.labelSelectors ?? []).map((selector) => {
			const [key, value] = selector.split(":", 2);
			const normalizedKey = normalizeLabelKey(key ?? "");
			const normalizedValue = normalizeLabelValue(value);
			return normalizedValue ? `${normalizedKey}:${normalizedValue}` : normalizedKey;
		});
		const claimedThreadIds = new Set(
			Array.from(this.claims.values())
				.filter((claim) => claim.status === "active")
				.map((claim) => claim.threadId),
		);
		for (const topic of Array.from(this.topics.values()).sort((a, b) => a.createdAt - b.createdAt)) {
			if (topic.status === "resolved" || topic.status === "cancelled" || topic.lifecycle === "archived") {
				continue;
			}
			if (claimedThreadIds.has(topic.threadId)) {
				continue;
			}
			const thread = this.requireThread(topic.threadId);
			const selectorSet = this.selectorSetForThread(topic, thread);
			const matches = selectors.every((selector) => selectorSet.has(selector));
			if (matches || selectors.length === 0) {
				return { topic, thread };
			}
		}
		throw new Error(`No discourse target matched selectors: ${(request.labelSelectors ?? []).join(", ")}`);
	}

	private ensureForumInternal(
		board: DiscourseBoard,
		options: {
			forumId?: string;
			key: string;
			title?: string;
			description?: string;
			labels?: ReadonlyArray<LabelInput>;
		},
	): DiscourseForum {
		const existing = this.getForumRecord(board.id, options.forumId, options.key);
		const now = Date.now();
		const forum: DiscourseForum = existing
			? {
					...existing,
					key: options.key,
					title: options.title?.trim() || existing.title,
					description: options.description?.trim() || existing.description,
					labels: this.entityLabels(board, existing, {
						extra: options.labels,
						fallbackSource: "system",
						existing: existing.labels,
					}),
					updatedAt: now,
				}
			: {
					id: options.forumId ?? randomUUID(),
					boardId: board.id,
					key: options.key,
					title: options.title?.trim() || titleize(options.key),
					description: options.description?.trim() || undefined,
					labels: this.entityLabels(
						board,
						{
							id: options.forumId ?? randomUUID(),
							boardId: board.id,
							key: options.key,
							title: options.title?.trim() || titleize(options.key),
							description: options.description?.trim() || undefined,
							labels: [],
							createdAt: now,
							updatedAt: now,
						},
						{
							extra: options.labels,
							fallbackSource: "system",
						},
					),
					createdAt: now,
					updatedAt: now,
				};
		this.upsertForum(forum);
		return forum;
	}

	ensureBoard(request: EnsureDiscourseBoardRequest): DiscourseBoard {
		this.ensureHydrated();
		const existing = this.getBoardRecord(request.boardId, request.boardKey);
		const boardLookup = request.boardId?.trim();
		const boardKey = normalizeSegment(
			request.boardKey ??
				(boardLookup ? (existing?.id === boardLookup ? existing.key : boardLookup) : undefined) ??
				existing?.key,
			this.defaultBoardKey,
		);
		const defaultForumKey = normalizeSegment(
			request.defaultForumKey ?? request.defaultForumId ?? existing?.defaultForumKey,
			existing?.defaultForumKey ?? "general",
		);
		const now = Date.now();
		let board: DiscourseBoard = existing
			? {
					...existing,
					key: boardKey,
					title: request.title?.trim() || existing.title,
					description: request.description?.trim() || existing.description,
					defaultForumKey,
					metadata: { ...existing.metadata, ...(request.metadata ? cloneValue(request.metadata) : {}) },
					labels: buildLabels(request.labels, "system", existing.labels),
					updatedAt: now,
				}
			: {
					id: randomUUID(),
					key: boardKey,
					title: request.title?.trim() || titleize(boardKey),
					description: request.description?.trim() || undefined,
					defaultForumId: randomUUID(),
					defaultForumKey,
					metadata: {
						...this.defaultBoardMetadata(),
						...(request.metadata ? cloneValue(request.metadata) : {}),
					},
					labels: buildLabels(
						[{ key: "board", value: boardKey, source: "system" }, ...(request.labels ?? [])],
						"system",
					),
					createdAt: now,
					updatedAt: now,
				};
		this.upsertBoard(board);
		const defaultForum = this.ensureForumInternal(board, {
			forumId: board.defaultForumId,
			key: defaultForumKey,
			title: defaultForumKey === "general" ? "General" : titleize(defaultForumKey),
		});
		if (board.defaultForumId !== defaultForum.id || board.defaultForumKey !== defaultForum.key) {
			board = {
				...board,
				defaultForumId: defaultForum.id,
				defaultForumKey: defaultForum.key,
				updatedAt: Date.now(),
			};
			this.upsertBoard(board);
		}
		return cloneValue(board);
	}

	ensureForum(request: EnsureDiscourseForumRequest): DiscourseForum {
		this.ensureHydrated();
		const board =
			this.getBoardRecord(request.boardId) ??
			this.ensureBoard({
				boardId: request.boardId,
				boardKey: request.boardKey,
			});
		const existing = this.getForumRecord(board.id, request.forumId, request.forumKey);
		const forumLookup = request.forumId?.trim();
		const forumKey = normalizeSegment(
			request.forumKey ??
				(forumLookup ? (existing?.id === forumLookup ? existing.key : forumLookup) : undefined) ??
				existing?.key,
			board.defaultForumKey,
		);
		return cloneValue(
			this.ensureForumInternal(board, {
				forumId: existing?.id,
				key: forumKey,
				title: request.title,
				description: request.description,
				labels: request.labels,
			}),
		);
	}

	createTemplate(request: CreateDiscourseTemplateRequest): DiscourseTemplate {
		this.ensureHydrated();
		const now = Date.now();
		const anchor = requireNonEmpty(request.anchor, "Template anchor cannot be empty.");
		const board = this.ensureBoard({ boardId: request.boardId, boardKey: request.boardKey });
		const forum = this.ensureForum({
			boardId: board.id,
			forumId: request.forumId ?? request.forumKey ?? board.defaultForumKey,
			forumKey: request.forumKey,
			title: request.forumId === "general" || request.forumKey === "general" ? "General" : undefined,
		});
		const template: DiscourseTemplate = {
			id: randomUUID(),
			kind: "template",
			anchor,
			key: normalizeSegment(request.key ?? anchor, "template"),
			title: request.title?.trim() || anchor,
			boardId: board.id,
			forumId: forum.id,
			status: "draft",
			sections: (request.sections ?? []).map((section, index) => ({
				id: randomUUID(),
				title: requireNonEmpty(section.title, "Template section title cannot be empty."),
				body: section.body?.trim() ?? "",
				status: section.status?.trim() || undefined,
				order: index,
			})),
			labels: this.entityLabels(board, forum, {
				extra: request.labels,
				fallbackSource: "system",
			}),
			approvedBy: request.requestedBy?.trim() || undefined,
			createdAt: now,
			updatedAt: now,
		};
		this.upsertTemplate(template);
		return this.cloneTemplate(template);
	}

	createContract(request: CreateDiscourseContractRequest): DiscourseContract {
		return this.createTemplate(request);
	}

	approveTemplate(request: ApproveDiscourseTemplateRequest): DiscourseTemplate {
		const template = this.requireTemplate(request.templateId);
		const stamp = this.requestStamp({
			templateId: template.id,
			requestedBy: request.approvedBy?.trim() || "system",
		});
		this.decideStamp({
			stampId: stamp.id,
			decision: "approved",
			decidedBy: request.approvedBy?.trim() || "system",
			rationale: request.rationale,
			input: request.input,
		});
		const updated: DiscourseTemplate = {
			...template,
			status: template.status === "active" ? "active" : "approved",
			approvedBy: request.approvedBy?.trim() || template.approvedBy,
			updatedAt: Date.now(),
		};
		this.upsertTemplate(updated);
		return this.cloneTemplate(updated);
	}

	approveContract(request: ApproveDiscourseContractRequest): DiscourseContract {
		return this.approveTemplate({
			templateId: request.contractId,
			approvedBy: request.approvedBy,
			rationale: request.rationale,
			input: request.input,
		});
	}

	rejectTemplate(request: ApproveDiscourseTemplateRequest): DiscourseTemplate {
		const template = this.requireTemplate(request.templateId);
		const stamp = this.requestStamp({
			templateId: template.id,
			requestedBy: request.approvedBy?.trim() || "system",
		});
		this.decideStamp({
			stampId: stamp.id,
			decision: "rejected",
			decidedBy: request.approvedBy?.trim() || "system",
			rationale: request.rationale,
			input: request.input,
		});
		const updated: DiscourseTemplate = {
			...template,
			status: "rejected",
			updatedAt: Date.now(),
		};
		this.upsertTemplate(updated);
		return this.cloneTemplate(updated);
	}

	rejectContract(request: ApproveDiscourseContractRequest): DiscourseContract {
		return this.rejectTemplate({
			templateId: request.contractId,
			approvedBy: request.approvedBy,
			rationale: request.rationale,
			input: request.input,
		});
	}

	createTopic(request: CreateDiscourseTopicRequest): BlackboardTopicSummary {
		this.ensureHydrated();
		const templateId = request.templateId ?? request.satisfiesTemplateId ?? request.contractId;
		const template = templateId ? this.requireTemplate(templateId) : undefined;
		const requestedAddress = request.address ? normalizeAddress(request.address) : undefined;
		const board = this.ensureBoard({
			boardId: request.boardId ?? template?.boardId ?? requestedAddress?.boardId,
			boardKey: request.boardKey ?? requestedAddress?.boardId,
		});
		const templateForum = template ? this.requireForum(template.forumId) : undefined;
		const forum = this.ensureForum({
			boardId: board.id,
			forumId: request.forumId ?? templateForum?.key ?? requestedAddress?.forumId ?? board.defaultForumKey,
			forumKey: request.forumKey,
			title:
				(request.forumId ?? request.forumKey ?? templateForum?.key ?? requestedAddress?.forumId) === "general"
					? "General"
					: undefined,
		});
		const topicKey = this.uniqueTopicKey(
			board.key,
			forum.key,
			requestedAddress?.topicId ?? request.key ?? request.title,
		);
		const threadKey = this.uniqueThreadKey(board.key, forum.key, topicKey, requestedAddress?.threadId ?? "thread");
		const now = Date.now();
		const routingState = forum.key === board.defaultForumKey ? "general" : "scoped";
		const topicId = randomUUID();
		const threadId = randomUUID();
		const topicAddress: BoardPath = {
			boardId: board.key,
			forumId: forum.key,
			topicId: topicKey,
		};
		const threadAddress: BoardPath = {
			boardId: board.key,
			forumId: forum.key,
			topicId: topicKey,
			threadId: threadKey,
		};
		const labels = this.entityLabels(board, forum, {
			routingState,
			templateId,
			extra: request.labels,
			fallbackSource: "system",
		});
		const lifecycle = request.lifecycle ?? "waiting";
		const thread: DiscourseThread = {
			id: threadId,
			topicId,
			key: threadKey,
			address: threadAddress,
			boardId: board.id,
			forumId: forum.id,
			title: requireNonEmpty(request.title, "Topic title cannot be empty."),
			status: "active",
			lifecycle,
			templateId,
			satisfiesTemplateId: request.satisfiesTemplateId ?? templateId,
			labels,
			createdAt: now,
			updatedAt: now,
		};
		const topic: DiscourseTopic = {
			id: topicId,
			key: topicKey,
			address: topicAddress,
			boardId: board.id,
			forumId: forum.id,
			title: thread.title,
			status: "open",
			lifecycle,
			threadId: thread.id,
			templateId,
			satisfiesTemplateId: request.satisfiesTemplateId ?? templateId,
			templateSectionIds: request.templateSectionIds ? [...request.templateSectionIds] : undefined,
			contractId: request.contractId ?? templateId,
			labels,
			originForumId: forum.id,
			originForumKey: forum.key,
			currentForumId: forum.id,
			routingState,
			affinityKey: request.affinityKey?.trim() || undefined,
			createdAt: now,
			updatedAt: now,
		};
		this.upsertThread(thread);
		this.upsertTopic(topic);
		if (template && (template.status === "draft" || template.status === "approved")) {
			this.upsertTemplate({
				...template,
				status: "active",
				updatedAt: now,
			});
		}
		return this.buildTopicSummary(topic);
	}

	relocateTopic(request: RelocateDiscourseTopicRequest): BlackboardTopicSummary {
		this.ensureHydrated();
		const topic = this.requireTopic(request.topicId);
		const thread = this.requireThread(topic.threadId);
		const board = this.ensureBoard({ boardId: request.boardId ?? topic.boardId, boardKey: request.boardKey });
		const forum = this.ensureForum({
			boardId: board.id,
			forumId: request.forumId,
			forumKey: request.forumKey,
			title: request.forumId === "general" || request.forumKey === "general" ? "General" : undefined,
		});
		const routingState = forum.key === board.defaultForumKey ? "general" : "scoped";
		const topicAddress: BoardPath = {
			...topic.address,
			boardId: board.key,
			forumId: forum.key,
			topicId: topic.key,
		};
		const threadAddress: BoardPath = {
			...thread.address,
			boardId: board.key,
			forumId: forum.key,
			topicId: topic.key,
			threadId: thread.key,
		};
		const updatedAt = Date.now();
		const updatedTopic: DiscourseTopic = {
			...topic,
			address: topicAddress,
			boardId: board.id,
			forumId: forum.id,
			title: request.title?.trim() || topic.title,
			currentForumId: forum.id,
			routingState,
			labels: this.entityLabels(board, forum, {
				routingState,
				templateId: topic.templateId,
				extra: [
					{ key: "relocated-by", value: request.relocatedBy, source: "gensec" },
					...(request.reason ? [{ key: "reason", value: request.reason, source: "gensec" as const }] : []),
					...(request.labels ?? []),
				],
				fallbackSource: "gensec",
				existing: topic.labels,
			}),
			updatedAt,
		};
		const updatedThread: DiscourseThread = {
			...thread,
			address: threadAddress,
			boardId: board.id,
			forumId: forum.id,
			title: updatedTopic.title,
			labels: this.entityLabels(board, forum, {
				routingState,
				templateId: thread.templateId,
				extra: request.labels,
				fallbackSource: "gensec",
				existing: thread.labels,
			}),
			updatedAt,
		};
		const updatedLetters: DiscourseLetter[] = (this.lettersByThread.get(thread.id) ?? []).map((letter) => ({
			...letter,
			address: cloneValue(threadAddress),
			boardId: board.id,
			forumId: forum.id,
			routingState,
			labels: this.entityLabels(board, forum, {
				routingState,
				templateId: letter.templateId,
				extra: request.labels,
				fallbackSource: "gensec",
				existing: letter.labels,
			}),
		}));
		this.upsertTopic(updatedTopic);
		this.upsertThread(updatedThread);
		this.replaceThreadLetters(thread.id, updatedLetters);
		for (const affinity of Array.from(this.routeAffinitiesByBinding.values()).filter(
			(entry) => entry.topicId === topic.id && entry.threadId === thread.id,
		)) {
			this.upsertRouteAffinity({
				...affinity,
				boardId: board.id,
				boardKey: board.key,
				forumId: forum.id,
				forumKey: forum.key,
				topicKey: updatedTopic.key,
				threadKey: updatedThread.key,
				updatedAt,
			});
		}
		return this.buildTopicSummary(updatedTopic);
	}

	assignTopic(request: AssignDiscourseTopicRequest): DiscourseTopic {
		this.ensureHydrated();
		const topic = this.requireTopic(request.topicId);
		const lifecycle =
			request.status === "running" ? "running" : request.status === "assigned" ? topic.lifecycle : topic.lifecycle;
		const updated: DiscourseTopic = {
			...topic,
			status: request.status ?? "assigned",
			lifecycle,
			updatedAt: Date.now(),
			assignedAgentId: request.assignedAgentId ?? topic.assignedAgentId,
			assignedBlueprint: request.assignedBlueprint ?? topic.assignedBlueprint,
			summary: request.summary ?? topic.summary,
		};
		this.upsertTopic(updated);
		this.syncTopicLifecycle(updated.id);
		return cloneValue(updated);
	}

	updateTopic(request: UpdateDiscourseTopicRequest): DiscourseTopic {
		this.ensureHydrated();
		const topic = this.requireTopic(request.topicId);
		const updated: DiscourseTopic = {
			...topic,
			status: request.status ?? topic.status,
			lifecycle: request.lifecycle ?? topic.lifecycle,
			routingState: request.routingState ?? topic.routingState,
			updatedAt: Date.now(),
			assignedAgentId: request.assignedAgentId ?? topic.assignedAgentId,
			assignedBlueprint: request.assignedBlueprint ?? topic.assignedBlueprint,
			summary: request.summary ?? topic.summary,
			labels: request.labels ? buildLabels(request.labels, "agent", topic.labels) : cloneValue(topic.labels),
		};
		this.upsertTopic(updated);
		this.syncTopicLifecycle(updated.id);
		return cloneValue(updated);
	}

	postLetter(request: PostDiscourseLetterRequest): DiscourseLetter {
		this.ensureHydrated();
		const thread = request.threadId?.trim()
			? this.requireThread(request.threadId.trim())
			: request.address
				? this.getThreadByAddress(request.address)
				: undefined;
		if (!thread) {
			throw new Error("postLetter requires `threadId` or `address`.");
		}
		const topic = this.requireTopic(thread.topicId);
		if (topic.lifecycle === "archived") {
			throw new Error(`Topic ${topic.id} is archived and cannot receive new letters.`);
		}
		const board = this.requireBoard(topic.boardId);
		const forum = this.requireForum(topic.forumId);
		const body = requireNonEmpty(request.body, "Letter body cannot be empty.");
		const createdAt = Date.now();
		const lifecycle = topic.lifecycle === "sleep" || topic.lifecycle === "idle" ? "waiting" : topic.lifecycle;
		const letter: DiscourseLetter = {
			id: randomUUID(),
			threadId: thread.id,
			topicId: topic.id,
			address: cloneValue(thread.address),
			boardId: topic.boardId,
			forumId: topic.forumId,
			scope: request.scope,
			author: requireNonEmpty(request.author, "Letter author cannot be empty."),
			body,
			templateId: topic.templateId,
			satisfiesTemplateId: topic.satisfiesTemplateId,
			contractId: topic.contractId,
			labels: this.entityLabels(board, forum, {
				routingState: request.routingState ?? topic.routingState,
				templateId: topic.templateId,
				extra: request.labels,
				fallbackSource: request.runtimeId ? "agent" : "operator",
			}),
			routingState: request.routingState ?? topic.routingState,
			runtimeId: request.runtimeId,
			metadata: request.metadata ? cloneValue(request.metadata) : undefined,
			createdAt,
		};
		this.insertLetter(letter);
		this.upsertThread({
			...thread,
			lifecycle,
			updatedAt: createdAt,
		});
		this.upsertTopic({
			...topic,
			lifecycle,
			status: currentStatusForLifecycle(topic.status, lifecycle),
			updatedAt: createdAt,
		});
		return cloneValue(letter);
	}

	postOperatorLetter(request: PostOperatorDiscourseLetterRequest): DiscourseLetter {
		this.ensureHydrated();
		const board = this.ensureBoard({ boardId: request.boardId, boardKey: request.boardKey });
		let affinity = this.routeAffinitiesByBinding.get(request.sessionId);
		if (!affinity || affinity.boardId !== board.id) {
			const summary = this.createTopic({
				title: request.body.slice(0, 80) || `Operator ${request.sessionId}`,
				boardId: board.id,
				forumId: board.defaultForumKey,
				affinityKey: request.sessionId,
				lifecycle: "waiting",
				labels: [
					{ key: "ingress", value: "operator", source: "operator" },
					{ key: "session", value: request.sessionId, source: "operator" },
				],
			});
			const summaryBoard = summary.board ?? board;
			const summaryForum = summary.forum ?? this.requireForum(summary.topic.forumId);
			affinity = {
				id: randomUUID(),
				bindingKey: request.sessionId,
				boardId: summary.topic.boardId,
				boardKey: summaryBoard.key,
				forumId: summary.topic.forumId,
				forumKey: summaryForum.key,
				topicId: summary.topic.id,
				topicKey: summary.topic.key,
				threadId: summary.thread.id,
				threadKey: summary.thread.key,
				updatedAt: Date.now(),
			};
			this.upsertRouteAffinity(affinity);
		}
		const letter = this.postLetter({
			threadId: affinity.threadId,
			scope: "dialog",
			author: request.author?.trim() || "operator",
			body: request.body,
			labels: [
				{ key: "origin", value: "operator", source: "operator" },
				{ key: "session", value: request.sessionId, source: "operator" },
				...(request.labels ?? []),
			],
			metadata: request.metadata,
		});
		const topic = this.requireTopic(letter.topicId);
		const thread = this.requireThread(letter.threadId);
		const forum = this.requireForum(letter.forumId);
		const boardForLetter = this.requireBoard(letter.boardId);
		this.upsertRouteAffinity({
			...affinity,
			boardId: boardForLetter.id,
			boardKey: boardForLetter.key,
			forumId: forum.id,
			forumKey: forum.key,
			topicId: topic.id,
			topicKey: topic.key,
			threadId: thread.id,
			threadKey: thread.key,
			updatedAt: letter.createdAt,
		});
		return letter;
	}

	claimTarget(request: ClaimDiscourseTargetRequest): DiscourseClaim {
		this.ensureHydrated();
		this.expireClaims();
		const { topic, thread } = this.resolveClaimTarget(request);
		const targetAddress = boardPathToAddress(thread.address);
		const existing = Array.from(this.claims.values()).find(
			(claim) => claim.threadId === thread.id && claim.status === "active",
		);
		if (existing) {
			throw new Error(`Discourse target already claimed by ${existing.claimedBy}: ${targetAddress}`);
		}
		const selectors = (request.labelSelectors ?? []).map((selector) => {
			const [key, value] = selector.split(":", 2);
			const normalizedKey = normalizeLabelKey(key ?? "");
			const normalizedValue = normalizeLabelValue(value);
			return normalizedValue ? `${normalizedKey}:${normalizedValue}` : normalizedKey;
		});
		const selectorSet = this.selectorSetForThread(topic, thread);
		for (const selector of selectors) {
			if (!selectorSet.has(selector)) {
				throw new Error(`Claim selector ${selector} does not match discourse target ${targetAddress}`);
			}
		}
		const now = Date.now();
		const claim: DiscourseClaim = {
			id: randomUUID(),
			targetAddress,
			boardId: topic.boardId,
			forumId: topic.forumId,
			topicId: topic.id,
			threadId: thread.id,
			claimedBy: requireNonEmpty(request.claimedBy, "Claimed-by cannot be empty."),
			labelSelectors: selectors,
			status: "active",
			createdAt: now,
			updatedAt: now,
			expiresAt: now + Math.max(request.leaseMs ?? 5 * 60_000, 1_000),
			reason: request.reason?.trim() || undefined,
		};
		this.upsertClaim(claim);
		return cloneValue(claim);
	}

	renewClaim(request: RenewDiscourseClaimRequest): DiscourseClaim {
		this.ensureHydrated();
		const claim = this.requireClaim(request.claimId);
		const now = Date.now();
		const updated: DiscourseClaim = {
			...claim,
			status: "active",
			updatedAt: now,
			expiresAt: now + Math.max(request.leaseMs ?? 5 * 60_000, 1_000),
		};
		this.upsertClaim(updated);
		return cloneValue(updated);
	}

	releaseClaim(request: ReleaseDiscourseClaimRequest): DiscourseClaim {
		this.ensureHydrated();
		const claim = this.requireClaim(request.claimId);
		if (claim.claimedBy !== request.releasedBy) {
			throw new Error(`Claim ${claim.id} is owned by ${claim.claimedBy}, not ${request.releasedBy}`);
		}
		const updated: DiscourseClaim = {
			...claim,
			status: "released",
			updatedAt: Date.now(),
			reason: request.reason?.trim() || claim.reason,
		};
		this.upsertClaim(updated);
		return cloneValue(updated);
	}

	listClaims(address?: string): DiscourseClaim[] {
		this.ensureHydrated();
		this.expireClaims();
		const normalizedAddress = address ? boardPathToAddress(normalizeAddress(address)) : undefined;
		return Array.from(this.claims.values())
			.filter((claim) => (normalizedAddress ? claim.targetAddress === normalizedAddress : true))
			.sort((a, b) => a.createdAt - b.createdAt)
			.map((claim) => cloneValue(claim));
	}

	expireClaims(now: number = Date.now()): DiscourseClaim[] {
		this.ensureHydrated();
		const expired: DiscourseClaim[] = [];
		for (const claim of this.claims.values()) {
			if (claim.status === "active" && claim.expiresAt <= now) {
				const updated: DiscourseClaim = {
					...claim,
					status: "expired",
					updatedAt: now,
				};
				this.upsertClaim(updated);
				expired.push(cloneValue(updated));
			}
		}
		return expired;
	}

	requestStamp(request: RequestDiscourseStampRequest): DiscourseStamp {
		this.ensureHydrated();
		this.requireTemplate(request.templateId);
		const stamp: DiscourseStamp = {
			id: randomUUID(),
			templateId: request.templateId,
			requestedBy: requireNonEmpty(request.requestedBy, "Stamp requester cannot be empty."),
			requestedAt: Date.now(),
			decision: "pending",
		};
		this.upsertStamp(stamp);
		return cloneValue(stamp);
	}

	decideStamp(request: DecideDiscourseStampRequest): DiscourseStamp {
		this.ensureHydrated();
		const stamp = this.requireStamp(request.stampId);
		const updated: DiscourseStamp = {
			...stamp,
			decision: request.decision,
			decidedBy: requireNonEmpty(request.decidedBy, "Stamp decider cannot be empty."),
			decidedAt: Date.now(),
			rationale: request.rationale?.trim() || undefined,
			input: request.input?.trim() || undefined,
		};
		this.upsertStamp(updated);
		return cloneValue(updated);
	}

	listStamps(templateId?: string): DiscourseStamp[] {
		this.ensureHydrated();
		return Array.from(this.stamps.values())
			.filter((stamp) => (templateId ? stamp.templateId === templateId : true))
			.sort((a, b) => a.requestedAt - b.requestedAt)
			.map((stamp) => cloneValue(stamp));
	}

	archiveTopic(request: ArchiveDiscourseTopicRequest): BlackboardTopicSummary {
		this.ensureHydrated();
		const topic = this.requireTopic(request.topicId);
		const thread = this.requireThread(topic.threadId);
		const now = Date.now();
		const updatedTopic: DiscourseTopic = {
			...topic,
			lifecycle: "archived",
			status: topic.status === "cancelled" ? "cancelled" : "resolved",
			updatedAt: now,
			summary: request.reason?.trim() || topic.summary,
		};
		const updatedThread: DiscourseThread = {
			...thread,
			lifecycle: "archived",
			status: "closed",
			updatedAt: now,
		};
		this.upsertTopic(updatedTopic);
		this.upsertThread(updatedThread);
		for (const runtime of Array.from(this.runtimes.values()).filter((runtime) => runtime.topicId === topic.id)) {
			this.upsertRuntimeRecord({
				...runtime,
				status: "archived",
				updatedAt: now,
				latestSummary: request.reason?.trim() || runtime.latestSummary,
			});
		}
		for (const claim of Array.from(this.claims.values()).filter(
			(claim) => claim.topicId === topic.id && claim.status === "active",
		)) {
			this.upsertClaim({
				...claim,
				status: "released",
				updatedAt: now,
				reason: request.reason?.trim() || claim.reason,
			});
		}
		this.persistAgentCapacity();
		return this.buildTopicSummary(updatedTopic);
	}

	registerRuntime(runtime: ChildAgentSummary): ChildAgentSummary {
		this.ensureHydrated();
		const now = Date.now();
		const topic = runtime.topicId ? this.topics.get(runtime.topicId) : undefined;
		const discourseAddress = runtime.discourseAddress ?? (topic ? boardPathToAddress(topic.address) : undefined);
		const merged: ChildAgentSummary = {
			...runtime,
			discourseAddress,
			discourseObjectId: runtime.discourseObjectId ?? runtime.topicId,
			updatedAt: runtime.updatedAt || now,
			createdAt: runtime.createdAt || now,
		};
		this.upsertRuntimeRecord(merged);
		if (merged.topicId) {
			this.syncTopicLifecycle(merged.topicId);
		} else {
			this.persistAgentCapacity();
		}
		return cloneValue(merged);
	}

	updateRuntime(request: UpdateRuntimeRequest): ChildAgentSummary {
		this.ensureHydrated();
		const runtime = this.requireRuntime(request.runtimeId);
		const updated: ChildAgentSummary = {
			...runtime,
			status: request.status ?? runtime.status,
			lastError: request.lastError ?? runtime.lastError,
			latestSummary: request.latestSummary ?? runtime.latestSummary,
			discourseAddress: request.discourseAddress ?? runtime.discourseAddress,
			topicId: request.topicId ?? runtime.topicId,
			threadId: request.threadId ?? runtime.threadId,
			claimId: request.claimId ?? runtime.claimId,
			discourseObjectId: runtime.discourseObjectId ?? request.topicId ?? runtime.topicId,
			updatedAt: Date.now(),
		};
		this.upsertRuntimeRecord(updated);
		if (updated.topicId) {
			this.syncTopicLifecycle(updated.topicId);
		} else {
			this.persistAgentCapacity();
		}
		return cloneValue(updated);
	}

	listRuntimes(topicId?: string): ChildAgentSummary[] {
		this.ensureHydrated();
		return Array.from(this.runtimes.values())
			.filter((runtime) => (topicId ? runtime.topicId === topicId : true))
			.sort((a, b) => a.createdAt - b.createdAt)
			.map((runtime) => cloneValue(runtime));
	}

	getRuntime(runtimeId: string): ChildAgentSummary | undefined {
		this.ensureHydrated();
		const runtime = this.runtimes.get(runtimeId);
		return runtime ? cloneValue(runtime) : undefined;
	}

	createKnowledgeAtom(request: CreateKnowledgeAtomRequest): KnowledgeAtom {
		this.ensureHydrated();
		const atom: KnowledgeAtom = {
			id: randomUUID(),
			kind: normalizeSegment(request.kind, "atom"),
			title: requireNonEmpty(request.title, "Knowledge atom title cannot be empty."),
			summary: request.summary?.trim() || undefined,
			body: requireNonEmpty(request.body, "Knowledge atom body cannot be empty."),
			scope: request.scope,
			sourceType: request.sourceType,
			sourceId: requireNonEmpty(request.sourceId, "Knowledge atom sourceId cannot be empty."),
			discourseObjectId: request.discourseObjectId,
			topicId: request.topicId,
			threadId: request.threadId,
			runtimeId: request.runtimeId,
			labels: buildLabels(request.labels, "agent"),
			createdBy: requireNonEmpty(request.createdBy, "Knowledge atom createdBy cannot be empty."),
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		this.upsertKnowledgeAtomRecord(atom);
		return cloneValue(atom);
	}

	createKnowledgeMolecule(request: CreateKnowledgeMoleculeRequest): KnowledgeMolecule {
		this.ensureHydrated();
		const molecule: KnowledgeMolecule = {
			id: randomUUID(),
			kind: normalizeSegment(request.kind, "molecule"),
			title: requireNonEmpty(request.title, "Knowledge molecule title cannot be empty."),
			summary: request.summary?.trim() || undefined,
			body: request.body?.trim() || undefined,
			atomIds: [...request.atomIds],
			sourceIds: request.sourceIds ? [...request.sourceIds] : [],
			sealed: request.sealed ?? true,
			discourseObjectId: request.discourseObjectId,
			topicId: request.topicId,
			threadId: request.threadId,
			runtimeId: request.runtimeId,
			labels: buildLabels(request.labels, "agent"),
			createdBy: requireNonEmpty(request.createdBy, "Knowledge molecule createdBy cannot be empty."),
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		this.upsertKnowledgeMoleculeRecord(molecule);
		return cloneValue(molecule);
	}

	listKnowledgeAtoms(request: ListKnowledgeArtifactsRequest = {}): KnowledgeAtom[] {
		this.ensureHydrated();
		return Array.from(this.knowledgeAtoms.values())
			.filter((atom) => (request.discourseObjectId ? atom.discourseObjectId === request.discourseObjectId : true))
			.filter((atom) => (request.topicId ? atom.topicId === request.topicId : true))
			.filter((atom) => (request.threadId ? atom.threadId === request.threadId : true))
			.filter((atom) => (request.runtimeId ? atom.runtimeId === request.runtimeId : true))
			.sort((a, b) => a.createdAt - b.createdAt)
			.map((atom) => cloneValue(atom));
	}

	listKnowledgeMolecules(request: ListKnowledgeArtifactsRequest = {}): KnowledgeMolecule[] {
		this.ensureHydrated();
		return Array.from(this.knowledgeMolecules.values())
			.filter((molecule) =>
				request.discourseObjectId ? molecule.discourseObjectId === request.discourseObjectId : true,
			)
			.filter((molecule) => (request.topicId ? molecule.topicId === request.topicId : true))
			.filter((molecule) => (request.threadId ? molecule.threadId === request.threadId : true))
			.filter((molecule) => (request.runtimeId ? molecule.runtimeId === request.runtimeId : true))
			.sort((a, b) => a.createdAt - b.createdAt)
			.map((molecule) => cloneValue(molecule));
	}

	upsertBudgetPolicy(request: UpsertBudgetPolicyRequest): BudgetPolicy {
		this.ensureHydrated();
		const existing =
			(request.id ? this.budgetPolicies.get(request.id) : undefined) ??
			Array.from(this.budgetPolicies.values()).find(
				(policy) => policy.scope === request.scope && policy.targetId === request.targetId,
			);
		const now = Date.now();
		const policy: BudgetPolicy = existing
			? {
					...existing,
					name: request.name ?? existing.name,
					scope: request.scope,
					targetId: request.targetId,
					createdBy: request.createdBy ?? existing.createdBy,
					enabled: request.enabled ?? existing.enabled,
					day: request.day ?? existing.day,
					week: request.week ?? existing.week,
					month: request.month ?? existing.month,
					updatedAt: now,
				}
			: {
					id: request.id ?? randomUUID(),
					name: request.name,
					scope: request.scope,
					targetId: request.targetId,
					createdBy: request.createdBy,
					enabled: request.enabled ?? true,
					day: request.day,
					week: request.week,
					month: request.month,
					createdAt: now,
					updatedAt: now,
				};
		this.upsertBudgetPolicyRecord(policy);
		return cloneValue(policy);
	}

	listBudgetPolicies(targetId?: string): BudgetPolicy[] {
		this.ensureHydrated();
		return Array.from(this.budgetPolicies.values())
			.filter((policy) => (targetId ? policy.targetId === targetId : true))
			.sort((a, b) => a.createdAt - b.createdAt)
			.map((policy) => cloneValue(policy));
	}

	recordBudgetUsage(request: RecordBudgetUsageRequest): BudgetStatusSnapshot[] {
		this.ensureHydrated();
		const occurredAt = request.occurredAt ?? Date.now();
		const inputTokens = request.inputTokens;
		const outputTokens = request.outputTokens;
		const cacheReadTokens = request.cacheReadTokens ?? 0;
		const cacheWriteTokens = request.cacheWriteTokens ?? 0;
		const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
		const targets: Array<{ scope: BudgetLedgerEntry["scope"]; targetId?: string }> = [
			{ scope: "global" },
			...(request.agentId ? [{ scope: "agent" as const, targetId: request.agentId }] : []),
			...(request.discourseObjectId
				? [{ scope: "discourse_object" as const, targetId: request.discourseObjectId }]
				: []),
		];
		for (const target of targets) {
			for (const window of ["day", "week", "month"] as const) {
				const { bucket, bucketStart } = getBudgetBucket(window, occurredAt);
				const existing = this.findBudgetLedger(target.scope, target.targetId, window, bucket);
				const next: BudgetLedgerEntry = existing
					? {
							...existing,
							inputTokens: existing.inputTokens + inputTokens,
							outputTokens: existing.outputTokens + outputTokens,
							cacheReadTokens: existing.cacheReadTokens + cacheReadTokens,
							cacheWriteTokens: existing.cacheWriteTokens + cacheWriteTokens,
							totalTokens: existing.totalTokens + totalTokens,
							totalCost: existing.totalCost + (request.totalCost ?? 0),
							updatedAt: occurredAt,
						}
					: {
							id: randomUUID(),
							scope: target.scope,
							targetId: target.targetId,
							window,
							bucket,
							bucketStart,
							inputTokens,
							outputTokens,
							cacheReadTokens,
							cacheWriteTokens,
							totalTokens,
							totalCost: request.totalCost ?? 0,
							updatedAt: occurredAt,
						};
				const policy = this.applicableBudgetPolicies(request.agentId, request.discourseObjectId).find(
					(candidate) => candidate.scope === target.scope && candidate.targetId === target.targetId,
				);
				next.lastAction = determineBudgetAction(policy?.[window], next.totalTokens);
				this.upsertBudgetLedgerRecord(next);
			}
		}
		return this.readBudgetStatus({
			agentId: request.agentId,
			discourseObjectId: request.discourseObjectId,
			at: occurredAt,
		});
	}

	readBudgetStatus(request: ReadBudgetStatusRequest): BudgetStatusSnapshot[] {
		this.ensureHydrated();
		return this.buildBudgetSnapshots(request.agentId, request.discourseObjectId, request.at ?? Date.now());
	}

	listBudgetLedger(targetId?: string): BudgetLedgerEntry[] {
		this.ensureHydrated();
		return Array.from(this.budgetLedger.values())
			.filter((entry) => (targetId ? entry.targetId === targetId : true))
			.sort((a, b) => a.bucketStart - b.bucketStart)
			.map((entry) => cloneValue(entry));
	}

	getAgentCapacity(): AgentCapacity {
		this.ensureHydrated();
		return {
			...cloneValue(this.agentCapacity),
			activeRuntimeIds: this.currentCapacityRuntimeIds(),
		};
	}

	setAgentCapacity(request: SetAgentCapacityRequest): AgentCapacity {
		this.ensureHydrated();
		this.agentCapacity = {
			...this.agentCapacity,
			maxConcurrent: Math.max(1, Math.floor(request.maxConcurrent)),
			activeRuntimeIds: this.currentCapacityRuntimeIds(),
			updatedAt: Date.now(),
		};
		this.driver.upsertAgentCapacity(this.agentCapacity);
		return this.getAgentCapacity();
	}

	listBoards(): DiscourseBoard[] {
		this.ensureHydrated();
		return Array.from(this.boards.values())
			.sort((a, b) => a.createdAt - b.createdAt)
			.map((board) => cloneValue(board));
	}

	listForums(boardId?: string): DiscourseForum[] {
		this.ensureHydrated();
		const board = boardId ? this.getBoardRecord(boardId) : undefined;
		return Array.from(this.forums.values())
			.filter((forum) => (board ? forum.boardId === board.id : true))
			.sort((a, b) => a.createdAt - b.createdAt)
			.map((forum) => cloneValue(forum));
	}

	listTemplates(): DiscourseTemplate[] {
		this.ensureHydrated();
		return Array.from(this.templates.values())
			.sort((a, b) => a.createdAt - b.createdAt)
			.map((template) => this.cloneTemplate(template));
	}

	listContracts(): DiscourseContract[] {
		return this.listTemplates();
	}

	listTopics(templateId?: string): BlackboardTopicSummary[] {
		this.ensureHydrated();
		return Array.from(this.topics.values())
			.filter((topic) => {
				if (!templateId) {
					return true;
				}
				return (
					topic.templateId === templateId ||
					topic.satisfiesTemplateId === templateId ||
					topic.contractId === templateId
				);
			})
			.sort((a, b) => a.createdAt - b.createdAt)
			.map((topic) => this.buildTopicSummary(topic));
	}

	readThread(request: ReadDiscourseThreadRequest): DiscourseThreadView {
		this.ensureHydrated();
		const thread = request.threadId?.trim()
			? this.requireThread(request.threadId.trim())
			: request.topicId?.trim()
				? this.requireThread(this.requireTopic(request.topicId.trim()).threadId)
				: request.address
					? this.getThreadByAddress(request.address)
					: undefined;
		if (!thread) {
			throw new Error("readThread requires `threadId`, `topicId`, or `address`.");
		}
		const topic = this.requireTopic(thread.topicId);
		const template = this.getTemplateForTopic(topic);
		const board = this.getBoardForThread(thread);
		const forum = this.getForumForThread(thread);
		const runtimes = this.getRuntimesForTopic(topic.id);
		const budget = this.readBudgetStatus({
			discourseObjectId: topic.id,
			agentId: runtimes[0]?.id,
		});
		return {
			board: board ? cloneValue(board) : undefined,
			forum: forum ? cloneValue(forum) : undefined,
			template: template ? cloneValue(template) : undefined,
			contract: template ? cloneValue(template) : undefined,
			topic: cloneValue(topic),
			thread: cloneValue(thread),
			letters: (this.lettersByThread.get(thread.id) ?? []).map((letter) => cloneValue(letter)),
			claims: this.getClaimsForThread(thread),
			stamps: this.getStampsForTemplate(template?.id),
			runtimes,
			budget,
			atoms: this.getAtomsForTopic(topic.id, thread.id),
			molecules: this.getMoleculesForTopic(topic.id, thread.id),
		};
	}

	getBoard(boardId: string): DiscourseBoard | undefined {
		this.ensureHydrated();
		const board = this.getBoardRecord(boardId);
		return board ? cloneValue(board) : undefined;
	}

	getForum(forumId: string): DiscourseForum | undefined {
		this.ensureHydrated();
		const byId = this.forums.get(forumId);
		if (byId) {
			return cloneValue(byId);
		}
		for (const forum of this.forums.values()) {
			if (forum.key === normalizeSegment(forumId, "general")) {
				return cloneValue(forum);
			}
		}
		return undefined;
	}

	getTemplate(templateId: string): DiscourseTemplate | undefined {
		this.ensureHydrated();
		const template = this.templates.get(templateId);
		return template ? this.cloneTemplate(template) : undefined;
	}

	getContract(contractId: string): DiscourseContract | undefined {
		return this.getTemplate(contractId);
	}

	getTopic(topicId: string): DiscourseTopic | undefined {
		this.ensureHydrated();
		const topic = this.topics.get(topicId);
		return topic ? cloneValue(topic) : undefined;
	}

	getTopicByAddress(address: string | DiscourseAddress): DiscourseTopic | undefined {
		this.ensureHydrated();
		const normalized = boardPathToAddress(normalizeAddress(address));
		const topicId = this.topicIdsByAddress.get(normalized);
		return topicId ? this.getTopic(topicId) : undefined;
	}

	getThread(threadId: string): DiscourseThread | undefined {
		this.ensureHydrated();
		const thread = this.threads.get(threadId);
		return thread ? cloneValue(thread) : undefined;
	}

	getThreadByAddress(address: string | DiscourseAddress): DiscourseThread | undefined {
		this.ensureHydrated();
		const normalized = normalizeAddress(address);
		const threadAddress = boardPathToAddress(normalized);
		const directThreadId = this.threadIdsByAddress.get(threadAddress);
		if (directThreadId) {
			return this.getThread(directThreadId);
		}
		if (!normalized.threadId) {
			const topicId = this.topicIdsByAddress.get(boardPathToAddress(normalized));
			if (!topicId) {
				return undefined;
			}
			return this.getThread(this.requireTopic(topicId).threadId);
		}
		return undefined;
	}
}

export const SessionBackedDiscourseStore = DoltBackedDiscourseStore;
