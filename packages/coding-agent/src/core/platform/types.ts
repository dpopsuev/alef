import type { AgentRole, CompiledAgentDefinition } from "@dpopsuev/alef-agent-blueprint";
import type {
	AgentActionMetadata,
	AgentCapabilityAvailability,
	AgentCapabilityDefinition,
	AgentCapabilityKind,
	AgentMessage,
	ToolExecutionMode,
} from "@dpopsuev/alef-agent-core";
import type { BoardPath } from "@dpopsuev/alef-agent-runtime/board";
import type { SessionContext, SessionEntry } from "../session-manager.js";
import type { SourceInfo } from "../source-info.js";

export type { AgentActionMetadata, AgentCapabilityAvailability, AgentCapabilityDefinition, AgentCapabilityKind };
export type {
	AgentDefinitionCapabilities,
	AgentDefinitionChildReference,
	AgentDefinitionDelegationConfig,
	AgentDefinitionDependenciesConfig,
	AgentDefinitionHooks,
	AgentDefinitionInput,
	AgentDefinitionLoopConfig,
	AgentDefinitionMemory,
	AgentDefinitionOrganInput,
	AgentDefinitionPolicies,
	AgentDefinitionSupervisorPolicyConfig,
	AgentLoopStopOnBudgetAction,
	AgentLoopStrategy,
	AgentModelSelector,
	AgentOrganName,
	AgentRole,
	CompiledAgentDefinition,
	CompiledAgentOrganDefinition,
	ResolvedAgentDefinitionChild,
	SupervisorUpgradePolicy,
} from "@dpopsuev/alef-agent-blueprint";

export type PlatformActionSource = "llm_tool_call" | "runtime";

export interface PlatformActionInfo {
	name: string;
	label: string;
	description: string;
	action: AgentActionMetadata;
	parameters?: unknown;
	executionMode?: ToolExecutionMode;
	sourceInfo?: SourceInfo;
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

export interface SessionMemoryPort {
	getMessages(): AgentMessage[];
	getEntries(): SessionEntry[];
	buildContext(): SessionContext;
	getSessionId(): string;
	getSessionFile(): string | undefined;
}

export interface AgentMemoryPorts {
	session: SessionMemoryPort;
	working: WorkingMemoryPort;
}

export type DiscourseLabelSource = "auto" | "coordinator" | "operator" | "agent" | "system";

export interface DiscourseLabel {
	id: string;
	key: string;
	value?: string;
	source: DiscourseLabelSource;
	createdAt: number;
}

export interface DiscourseBoard {
	id: string;
	key: string;
	title: string;
	description?: string;
	defaultForumId: string;
	defaultForumKey: string;
	metadata: Record<string, unknown>;
	labels: DiscourseLabel[];
	createdAt: number;
	updatedAt: number;
}

export interface DiscourseForum {
	id: string;
	boardId: string;
	key: string;
	title: string;
	description?: string;
	labels: DiscourseLabel[];
	createdAt: number;
	updatedAt: number;
}

export type DiscourseScope = "dialog" | "monolog" | "system" | "template";

export type DiscourseAddress = BoardPath;

export type DiscourseRoutingState = "general" | "scoped" | "off_topic";

export type DiscourseTemplateStatus = "draft" | "approved" | "active" | "completed" | "cancelled" | "rejected";

export type DiscourseContractStatus = DiscourseTemplateStatus;

export type DiscourseTopicStatus = "open" | "assigned" | "running" | "resolved" | "cancelled";

export type DiscourseThreadStatus = "active" | "closed";

export type DiscourseClaimStatus = "active" | "released" | "expired" | "rejected";

export type DiscourseStampDecision = "pending" | "approved" | "rejected";

export type DiscourseLifecycleState = "waiting" | "running" | "idle" | "sleep" | "draining" | "archived" | "error";

export type BudgetWindow = "day" | "week" | "month";

export type BudgetScopeVector = "global" | "agent" | "discourse_object";

export type BudgetThresholdAction = "inform" | "warn" | "throttle" | "abort";

export interface BudgetWindowPolicy {
	maxTokens: number;
	informAt?: number;
	warnAt?: number;
	throttleAt?: number;
	abortAt?: number;
}

export interface BudgetPolicy {
	id: string;
	name?: string;
	scope: BudgetScopeVector;
	targetId?: string;
	createdBy?: string;
	enabled: boolean;
	day?: BudgetWindowPolicy;
	week?: BudgetWindowPolicy;
	month?: BudgetWindowPolicy;
	createdAt: number;
	updatedAt: number;
}

export interface BudgetLedgerEntry {
	id: string;
	scope: BudgetScopeVector;
	targetId?: string;
	window: BudgetWindow;
	bucket: string;
	bucketStart: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	totalCost: number;
	lastAction?: BudgetThresholdAction;
	updatedAt: number;
}

export interface BudgetStatusSnapshot {
	scope: BudgetScopeVector;
	targetId?: string;
	window: BudgetWindow;
	bucket: string;
	maxTokens: number;
	usedTokens: number;
	remainingTokens: number;
	action?: BudgetThresholdAction;
	throttled: boolean;
	blocked: boolean;
}

export interface AgentCapacity {
	id: string;
	maxConcurrent: number;
	activeRuntimeIds: string[];
	updatedAt: number;
}

export interface KnowledgeArtifactBase {
	id: string;
	kind: string;
	title: string;
	summary?: string;
	labels: DiscourseLabel[];
	discourseObjectId?: string;
	topicId?: string;
	threadId?: string;
	runtimeId?: string;
	createdBy: string;
	createdAt: number;
	updatedAt: number;
}

export interface KnowledgeAtom extends KnowledgeArtifactBase {
	body: string;
	scope: DiscourseScope;
	sourceType: "letter" | "thread" | "topic" | "template" | "runtime";
	sourceId: string;
}

export interface KnowledgeMolecule extends KnowledgeArtifactBase {
	body?: string;
	atomIds: string[];
	sourceIds: string[];
	sealed: boolean;
}

export interface DiscourseRouteAffinity {
	id: string;
	bindingKey: string;
	boardId: string;
	boardKey: string;
	forumId: string;
	forumKey: string;
	topicId: string;
	topicKey: string;
	threadId: string;
	threadKey: string;
	updatedAt: number;
}

export interface DiscourseClaim {
	id: string;
	targetAddress: string;
	boardId: string;
	forumId: string;
	topicId: string;
	threadId: string;
	claimedBy: string;
	labelSelectors: string[];
	status: DiscourseClaimStatus;
	createdAt: number;
	updatedAt: number;
	expiresAt: number;
	reason?: string;
}

export interface DiscourseStamp {
	id: string;
	templateId: string;
	requestedBy: string;
	requestedAt: number;
	decidedBy?: string;
	decidedAt?: number;
	decision: DiscourseStampDecision;
	rationale?: string;
	input?: string;
}

export interface DiscourseTemplateSection {
	id: string;
	title: string;
	body: string;
	status?: string;
	order: number;
}

export interface DiscourseTemplate {
	id: string;
	kind: "template";
	anchor: string;
	title: string;
	key: string;
	boardId: string;
	forumId: string;
	status: DiscourseTemplateStatus;
	sections: DiscourseTemplateSection[];
	labels: DiscourseLabel[];
	createdAt: number;
	updatedAt: number;
	approvedBy?: string;
}

export type DiscourseContract = DiscourseTemplate;

export interface DiscourseTopic {
	id: string;
	key: string;
	address: DiscourseAddress;
	boardId: string;
	forumId: string;
	title: string;
	status: DiscourseTopicStatus;
	lifecycle: DiscourseLifecycleState;
	threadId: string;
	createdAt: number;
	updatedAt: number;
	templateId?: string;
	satisfiesTemplateId?: string;
	templateSectionIds?: string[];
	contractId?: string;
	labels: DiscourseLabel[];
	originForumId: string;
	originForumKey: string;
	currentForumId: string;
	routingState: DiscourseRoutingState;
	affinityKey?: string;
	assignedAgentId?: string;
	assignedBlueprint?: string;
	summary?: string;
}

export interface DiscourseThread {
	id: string;
	topicId: string;
	key: string;
	address: DiscourseAddress;
	boardId: string;
	forumId: string;
	title: string;
	status: DiscourseThreadStatus;
	lifecycle: DiscourseLifecycleState;
	createdAt: number;
	updatedAt: number;
	templateId?: string;
	satisfiesTemplateId?: string;
	labels: DiscourseLabel[];
	parentThreadId?: string;
}

export interface DiscourseLetter {
	id: string;
	threadId: string;
	topicId: string;
	address: DiscourseAddress;
	boardId: string;
	forumId: string;
	scope: DiscourseScope;
	author: string;
	body: string;
	createdAt: number;
	templateId?: string;
	satisfiesTemplateId?: string;
	contractId?: string;
	labels: DiscourseLabel[];
	routingState?: DiscourseRoutingState;
	runtimeId?: string;
	metadata?: Record<string, unknown>;
}

export interface BlackboardTopicSummary {
	board?: DiscourseBoard;
	forum?: DiscourseForum;
	template?: DiscourseTemplate;
	contract?: DiscourseContract;
	topic: DiscourseTopic;
	thread: DiscourseThread;
	latestLetter?: DiscourseLetter;
	activeClaims: DiscourseClaim[];
	stamps: DiscourseStamp[];
}

export interface ReadDiscourseThreadRequest {
	threadId?: string;
	topicId?: string;
	address?: string | DiscourseAddress;
}

export interface DiscourseThreadView {
	board?: DiscourseBoard;
	forum?: DiscourseForum;
	template?: DiscourseTemplate;
	contract?: DiscourseContract;
	topic: DiscourseTopic;
	thread: DiscourseThread;
	letters: DiscourseLetter[];
	claims: DiscourseClaim[];
	stamps: DiscourseStamp[];
	runtimes: ChildAgentSummary[];
	budget: BudgetStatusSnapshot[];
	atoms: KnowledgeAtom[];
	molecules: KnowledgeMolecule[];
}

export interface EnsureDiscourseBoardRequest {
	boardId?: string;
	boardKey?: string;
	title?: string;
	description?: string;
	defaultForumId?: string;
	defaultForumKey?: string;
	metadata?: Record<string, unknown>;
	labels?: Array<{ key: string; value?: string; source?: DiscourseLabelSource }>;
}

export interface EnsureDiscourseForumRequest {
	boardId: string;
	boardKey?: string;
	forumId: string;
	forumKey?: string;
	title?: string;
	description?: string;
	labels?: Array<{ key: string; value?: string; source?: DiscourseLabelSource }>;
}

export interface CreateDiscourseContractRequest {
	anchor: string;
	title?: string;
	key?: string;
	sections?: Array<{ title: string; body: string; status?: string }>;
	requestedBy?: string;
	boardId?: string;
	boardKey?: string;
	forumId?: string;
	forumKey?: string;
	labels?: Array<{ key: string; value?: string; source?: DiscourseLabelSource }>;
}

export type CreateDiscourseTemplateRequest = CreateDiscourseContractRequest;

export interface ApproveDiscourseContractRequest {
	contractId: string;
	approvedBy?: string;
	rationale?: string;
	input?: string;
}

export interface ApproveDiscourseTemplateRequest {
	templateId: string;
	approvedBy?: string;
	rationale?: string;
	input?: string;
}

export interface CreateDiscourseTopicRequest {
	title: string;
	key?: string;
	address?: string | DiscourseAddress;
	templateId?: string;
	satisfiesTemplateId?: string;
	contractId?: string;
	templateSectionIds?: string[];
	boardId?: string;
	boardKey?: string;
	forumId?: string;
	forumKey?: string;
	labels?: Array<{ key: string; value?: string; source?: DiscourseLabelSource }>;
	affinityKey?: string;
	lifecycle?: DiscourseLifecycleState;
}

export interface AssignDiscourseTopicRequest {
	topicId: string;
	assignedAgentId?: string;
	assignedBlueprint?: string;
	status?: DiscourseTopicStatus;
	summary?: string;
}

export interface UpdateDiscourseTopicRequest {
	topicId: string;
	status?: DiscourseTopicStatus;
	lifecycle?: DiscourseLifecycleState;
	summary?: string;
	assignedAgentId?: string;
	assignedBlueprint?: string;
	labels?: Array<{ key: string; value?: string; source?: DiscourseLabelSource }>;
	routingState?: DiscourseRoutingState;
}

export interface PostDiscourseLetterRequest {
	threadId?: string;
	address?: string | DiscourseAddress;
	scope: DiscourseScope;
	author: string;
	body: string;
	runtimeId?: string;
	labels?: Array<{ key: string; value?: string; source?: DiscourseLabelSource }>;
	routingState?: DiscourseRoutingState;
	metadata?: Record<string, unknown>;
}

export interface PostOperatorDiscourseLetterRequest {
	body: string;
	sessionId: string;
	boardId?: string;
	boardKey?: string;
	author?: string;
	labels?: Array<{ key: string; value?: string; source?: DiscourseLabelSource }>;
	metadata?: Record<string, unknown>;
}

export interface RelocateDiscourseTopicRequest {
	topicId: string;
	boardId?: string;
	boardKey?: string;
	forumId: string;
	forumKey?: string;
	title?: string;
	relocatedBy: string;
	reason?: string;
	labels?: Array<{ key: string; value?: string; source?: DiscourseLabelSource }>;
}

export interface ClaimDiscourseTargetRequest {
	claimedBy: string;
	targetAddress?: string;
	topicId?: string;
	threadId?: string;
	labelSelectors?: string[];
	leaseMs?: number;
	reason?: string;
}

export interface RenewDiscourseClaimRequest {
	claimId: string;
	leaseMs?: number;
}

export interface ReleaseDiscourseClaimRequest {
	claimId: string;
	releasedBy: string;
	reason?: string;
}

export interface DecideDiscourseStampRequest {
	stampId: string;
	decision: Extract<DiscourseStampDecision, "approved" | "rejected">;
	decidedBy: string;
	rationale?: string;
	input?: string;
}

export interface RequestDiscourseStampRequest {
	templateId: string;
	requestedBy: string;
}

export interface ArchiveDiscourseTopicRequest {
	topicId: string;
	archivedBy: string;
	reason?: string;
}

export interface CreateKnowledgeAtomRequest {
	kind: string;
	title: string;
	body: string;
	scope: DiscourseScope;
	sourceType: KnowledgeAtom["sourceType"];
	sourceId: string;
	createdBy: string;
	discourseObjectId?: string;
	topicId?: string;
	threadId?: string;
	runtimeId?: string;
	labels?: Array<{ key: string; value?: string; source?: DiscourseLabelSource }>;
	summary?: string;
}

export interface CreateKnowledgeMoleculeRequest {
	kind: string;
	title: string;
	createdBy: string;
	atomIds: string[];
	sourceIds?: string[];
	body?: string;
	discourseObjectId?: string;
	topicId?: string;
	threadId?: string;
	runtimeId?: string;
	labels?: Array<{ key: string; value?: string; source?: DiscourseLabelSource }>;
	summary?: string;
	sealed?: boolean;
}

export interface ListKnowledgeArtifactsRequest {
	discourseObjectId?: string;
	topicId?: string;
	threadId?: string;
	runtimeId?: string;
}

export interface UpsertBudgetPolicyRequest {
	id?: string;
	name?: string;
	scope: BudgetScopeVector;
	targetId?: string;
	createdBy?: string;
	enabled?: boolean;
	day?: BudgetWindowPolicy;
	week?: BudgetWindowPolicy;
	month?: BudgetWindowPolicy;
}

export interface RecordBudgetUsageRequest {
	agentId?: string;
	discourseObjectId?: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	totalCost?: number;
	occurredAt?: number;
}

export interface ReadBudgetStatusRequest {
	agentId?: string;
	discourseObjectId?: string;
	at?: number;
}

export interface UpdateRuntimeRequest {
	runtimeId: string;
	status?: ChildAgentStatus;
	lastError?: string;
	latestSummary?: string;
	discourseAddress?: string;
	topicId?: string;
	threadId?: string;
	claimId?: string;
}

export interface SetAgentCapacityRequest {
	maxConcurrent: number;
}

export interface AgentDiscoursePort {
	ensureBoard(request: EnsureDiscourseBoardRequest): DiscourseBoard;
	ensureForum(request: EnsureDiscourseForumRequest): DiscourseForum;
	createTemplate(request: CreateDiscourseTemplateRequest): DiscourseTemplate;
	createContract(request: CreateDiscourseContractRequest): DiscourseContract;
	approveTemplate(request: ApproveDiscourseTemplateRequest): DiscourseTemplate;
	approveContract(request: ApproveDiscourseContractRequest): DiscourseContract;
	rejectTemplate(request: ApproveDiscourseTemplateRequest): DiscourseTemplate;
	rejectContract(request: ApproveDiscourseContractRequest): DiscourseContract;
	createTopic(request: CreateDiscourseTopicRequest): BlackboardTopicSummary;
	relocateTopic(request: RelocateDiscourseTopicRequest): BlackboardTopicSummary;
	assignTopic(request: AssignDiscourseTopicRequest): DiscourseTopic;
	updateTopic(request: UpdateDiscourseTopicRequest): DiscourseTopic;
	postLetter(request: PostDiscourseLetterRequest): DiscourseLetter;
	postOperatorLetter(request: PostOperatorDiscourseLetterRequest): DiscourseLetter;
	claimTarget(request: ClaimDiscourseTargetRequest): DiscourseClaim;
	renewClaim(request: RenewDiscourseClaimRequest): DiscourseClaim;
	releaseClaim(request: ReleaseDiscourseClaimRequest): DiscourseClaim;
	listClaims(address?: string): DiscourseClaim[];
	expireClaims(now?: number): DiscourseClaim[];
	requestStamp(request: RequestDiscourseStampRequest): DiscourseStamp;
	decideStamp(request: DecideDiscourseStampRequest): DiscourseStamp;
	listStamps(templateId?: string): DiscourseStamp[];
	listBoards(): DiscourseBoard[];
	listForums(boardId?: string): DiscourseForum[];
	listTemplates(): DiscourseTemplate[];
	listContracts(): DiscourseContract[];
	listTopics(templateId?: string): BlackboardTopicSummary[];
	readThread(request: ReadDiscourseThreadRequest): DiscourseThreadView;
	archiveTopic(request: ArchiveDiscourseTopicRequest): BlackboardTopicSummary;
	registerRuntime(runtime: ChildAgentSummary): ChildAgentSummary;
	updateRuntime(request: UpdateRuntimeRequest): ChildAgentSummary;
	listRuntimes(topicId?: string): ChildAgentSummary[];
	getRuntime(runtimeId: string): ChildAgentSummary | undefined;
	createKnowledgeAtom(request: CreateKnowledgeAtomRequest): KnowledgeAtom;
	createKnowledgeMolecule(request: CreateKnowledgeMoleculeRequest): KnowledgeMolecule;
	listKnowledgeAtoms(request?: ListKnowledgeArtifactsRequest): KnowledgeAtom[];
	listKnowledgeMolecules(request?: ListKnowledgeArtifactsRequest): KnowledgeMolecule[];
	upsertBudgetPolicy(request: UpsertBudgetPolicyRequest): BudgetPolicy;
	listBudgetPolicies(targetId?: string): BudgetPolicy[];
	recordBudgetUsage(request: RecordBudgetUsageRequest): BudgetStatusSnapshot[];
	readBudgetStatus(request: ReadBudgetStatusRequest): BudgetStatusSnapshot[];
	listBudgetLedger(targetId?: string): BudgetLedgerEntry[];
	getAgentCapacity(): AgentCapacity;
	setAgentCapacity(request: SetAgentCapacityRequest): AgentCapacity;
	getBoard(boardId: string): DiscourseBoard | undefined;
	getForum(forumId: string): DiscourseForum | undefined;
	getTemplate(templateId: string): DiscourseTemplate | undefined;
	getContract(contractId: string): DiscourseContract | undefined;
	getTopic(topicId: string): DiscourseTopic | undefined;
	getTopicByAddress(address: string | DiscourseAddress): DiscourseTopic | undefined;
	getThread(threadId: string): DiscourseThread | undefined;
	getThreadByAddress(address: string | DiscourseAddress): DiscourseThread | undefined;
}

export type ReviewNodeKind =
	| "document"
	| "board"
	| "forum"
	| "template"
	| "topic"
	| "thread"
	| "letter"
	| "claim"
	| "stamp"
	| "label"
	| "runtime"
	| "budget"
	| "atom"
	| "molecule"
	| "section"
	| "cell"
	| "widget"
	| "form"
	| "field";

export interface ReviewField {
	key: string;
	value: string;
	sensitive?: boolean;
}

export interface ReviewActionDescriptor {
	id: string;
	label: string;
	description?: string;
	enabled: boolean;
}

export interface ReviewComment {
	id: string;
	documentId: string;
	nodeId: string;
	author: string;
	body: string;
	createdAt: number;
	address?: string;
}

export interface ReviewNode {
	id: string;
	parentId?: string;
	kind: ReviewNodeKind;
	title: string;
	summary?: string;
	body?: string;
	status?: string;
	fields: ReviewField[];
	actions: ReviewActionDescriptor[];
}

export interface ReviewDocumentSummary {
	id: string;
	title: string;
	description?: string;
	updatedAt: number;
	boardId?: string;
	forumId?: string;
	targetAddress?: string;
	templateId?: string;
}

export interface ReviewDocument {
	id: string;
	title: string;
	description?: string;
	updatedAt: number;
	boardId?: string;
	forumId?: string;
	targetAddress?: string;
	templateId?: string;
	nodes: ReviewNode[];
	comments: ReviewComment[];
}

export interface AddReviewCommentRequest {
	documentId: string;
	nodeId: string;
	author: string;
	body: string;
	address?: string;
}

export interface ReviewBoardPort {
	listDocuments(): ReviewDocumentSummary[];
	getDocument(documentId?: string): ReviewDocument | undefined;
	getDocumentByAddress(address: string): ReviewDocument | undefined;
	addComment(request: AddReviewCommentRequest): ReviewComment;
}

export type ChildAgentStatus = DiscourseLifecycleState;

export interface ChildAgentSummary {
	id: string;
	name: string;
	role: "child";
	status: ChildAgentStatus;
	createdAt: number;
	updatedAt: number;
	cwd: string;
	sessionId: string;
	sessionFile?: string;
	definition: CompiledAgentDefinition;
	lastError?: string;
	templateId?: string;
	discourseAddress?: string;
	claimId?: string;
	contractId?: string;
	topicId?: string;
	threadId?: string;
	discourseObjectId?: string;
	latestSummary?: string;
}

export type SupervisorSignal = "abort" | "wait" | "sleep" | "drain";

export interface SpawnChildAgentRequest {
	definition: CompiledAgentDefinition;
	runtimeId?: string;
	name?: string;
	initialMessage?: string;
	templateId?: string;
	discourseAddress?: string;
	claimId?: string;
	contractId?: string;
	topicId?: string;
	threadId?: string;
	discourseObjectId?: string;
}

export interface SendChildAgentMessageRequest {
	agentId: string;
	message: string;
}

export interface SignalChildAgentRequest {
	agentId: string;
	signal: SupervisorSignal;
}

export interface KillChildAgentRequest {
	agentId: string;
}

export interface SupervisorPort {
	spawnAgent(request: SpawnChildAgentRequest): Promise<ChildAgentSummary>;
	listAgents(): ChildAgentSummary[];
	signalAgent(request: SignalChildAgentRequest): Promise<ChildAgentSummary>;
	killAgent(request: KillChildAgentRequest): Promise<ChildAgentSummary>;
	sendAgentMessage(request: SendChildAgentMessageRequest): Promise<ChildAgentSummary>;
}

export interface AgentPlatformContext {
	role: AgentRole;
	definition?: CompiledAgentDefinition;
	memory: AgentMemoryPorts;
	discourse: AgentDiscoursePort;
	review: ReviewBoardPort;
	supervisor?: SupervisorPort;
	actions: PlatformActionInfo[];
	getAction(name: string): PlatformActionInfo | undefined;
	getCapabilities(): AgentCapabilityDefinition[];
}
