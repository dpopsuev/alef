/** States with recoverable execution semantics owned by a Run. */
export type RunState =
	| "created"
	| "running"
	| "waiting-tool"
	| "waiting-human"
	| "completed"
	| "failed"
	| "cancelled";

/** Immutable limits compiled into one Run. */
export interface RunBudgetLimits {
	readonly maxToolCalls?: number;
	readonly maxElapsedMs?: number;
}

/** Persisted policy needed to reproduce command decisions after restart. */
export interface RunPolicyDefinition {
	readonly budget: RunBudgetLimits;
	readonly externalEffects: "allow" | "require-approval";
}

/** Durable budget consumption for one Run. */
export interface RunBudgetSnapshot {
	readonly toolCalls: number;
	readonly startedAt: number;
}

/** External-effect states that prevent ambiguous replay. */
export type EffectProposalStatus = "pending" | "approved" | "rejected" | "expired" | "executing" | "completed" | "failed";

/** Durable external effect awaiting or carrying a human decision. */
export interface EffectProposal {
	readonly id: string;
	readonly runId: string;
	readonly commandName: string;
	readonly commandVersion: number;
	readonly input: unknown;
	readonly status: EffectProposalStatus;
	readonly reviewer?: string;
	readonly createdAt: number;
	readonly updatedAt: number;
}

/** Current projection rebuilt transactionally with each run event. */
export interface RunSnapshot {
	readonly id: string;
	readonly sessionId: string;
	readonly state: RunState;
	readonly sequence: number;
	readonly policy: RunPolicyDefinition;
	readonly budget: RunBudgetSnapshot;
	readonly activeTools: number;
	readonly pendingEffectId?: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly failure?: string;
}

/** Facts that can change a Run snapshot. */
export type RunEventType =
	| "run.created"
	| "run.started"
	| "run.waiting-tool"
	| "run.tool-completed"
	| "run.tool-failed"
	| "run.budget-consumed"
	| "run.budget-exceeded"
	| "run.effect-proposed"
	| "run.effect-approved"
	| "run.effect-rejected"
	| "run.effect-expired"
	| "run.effect-execution-started"
	| "run.effect-completed"
	| "run.effect-failed"
	| "run.waiting-human"
	| "run.resumed"
	| "run.completed"
	| "run.failed"
	| "run.cancelled";

/** Unsequenced event proposed by the Run domain. */
export interface RunEventInput {
	readonly type: RunEventType;
	readonly payload: Readonly<Record<string, unknown>>;
	readonly correlationId?: string;
}

/** Committed event with per-run sequence and timestamp. */
export interface RunEvent extends RunEventInput {
	readonly runId: string;
	readonly sequence: number;
	readonly timestamp: number;
}

/** Atomic journal result returned before event fan-out. */
export interface RunAppendResult {
	readonly event: RunEvent;
	readonly snapshot: RunSnapshot;
}

/** Identity and policy required to create one Run. */
export interface CreateRunInput {
	readonly runId: string;
	readonly sessionId: string;
	readonly policy: RunPolicyDefinition;
	readonly timestamp?: number;
}

/** Stable storage conflict and transition failure codes. */
export type RunJournalErrorCode = "not-found" | "already-exists" | "sequence-conflict" | "invalid-transition";

/** Makes optimistic concurrency and lifecycle failures actionable. */
export class RunJournalError extends Error {
	constructor(readonly code: RunJournalErrorCode, message: string) {
		super(message);
		this.name = "RunJournalError";
	}
}

/** Persists Run events, snapshots, budgets, and effect proposals. */
export interface RunJournal {
	create(input: CreateRunInput): Promise<RunSnapshot>;
	get(runId: string): Promise<RunSnapshot | undefined>;
	append(runId: string, expectedSequence: number, event: RunEventInput): Promise<RunAppendResult>;
	events(runId: string, afterSequence: number, limit: number): Promise<RunEvent[]>;
	getEffectProposal(runId: string, proposalId: string): Promise<EffectProposal | undefined>;
}

/** Rejects malformed event data before it reaches a snapshot. */
function requiredString(payload: Readonly<Record<string, unknown>>, field: string): string {
	const value = payload[field];
	if (typeof value !== "string" || value.length === 0) throw new RunJournalError("invalid-transition", `${field} is required`);
	return value;
}

/** Applies common state-transition metadata. */
function transition(snapshot: RunSnapshot, state: RunState, event: RunEvent): RunSnapshot {
	return { ...snapshot, state, sequence: event.sequence, updatedAt: event.timestamp };
}

/** Reduces one sequenced event into the next Run snapshot. */
export function applyRunEvent(snapshot: RunSnapshot, event: RunEvent): RunSnapshot {
	if (event.sequence !== snapshot.sequence + 1)
		throw new RunJournalError("sequence-conflict", `run ${snapshot.id} expected sequence ${snapshot.sequence + 1}`);
	if (["completed", "failed", "cancelled"].includes(snapshot.state))
		throw new RunJournalError("invalid-transition", `run ${snapshot.id} is already ${snapshot.state}`);

	switch (event.type) {
		case "run.started":
			if (snapshot.state !== "created") throw new RunJournalError("invalid-transition", "only a created run can start");
			return transition(snapshot, "running", event);
		case "run.waiting-tool":
			if (snapshot.state !== "running" && snapshot.state !== "waiting-tool")
				throw new RunJournalError("invalid-transition", "run must be active before a tool starts");
			return { ...transition(snapshot, "waiting-tool", event), activeTools: snapshot.activeTools + 1 };
		case "run.tool-completed":
		case "run.tool-failed": {
			if (snapshot.state !== "waiting-tool" || snapshot.activeTools < 1)
				throw new RunJournalError("invalid-transition", "run is not waiting for a tool");
			const activeTools = snapshot.activeTools - 1;
			return { ...transition(snapshot, activeTools === 0 ? "running" : "waiting-tool", event), activeTools };
		}
		case "run.budget-consumed": {
			const { maxToolCalls, maxElapsedMs } = snapshot.policy.budget;
			if (maxToolCalls !== undefined && snapshot.budget.toolCalls >= maxToolCalls)
				throw new RunJournalError("invalid-transition", `maxToolCalls (${maxToolCalls}) exceeded`);
			if (maxElapsedMs !== undefined && event.timestamp - snapshot.budget.startedAt >= maxElapsedMs)
				throw new RunJournalError("invalid-transition", `maxElapsedMs (${maxElapsedMs}) exceeded`);
			return {
				...snapshot,
				budget: { ...snapshot.budget, toolCalls: snapshot.budget.toolCalls + 1 },
				sequence: event.sequence,
				updatedAt: event.timestamp,
			};
		}
		case "run.budget-exceeded":
			return { ...snapshot, sequence: event.sequence, updatedAt: event.timestamp };
		case "run.effect-proposed":
			if (snapshot.pendingEffectId) throw new RunJournalError("invalid-transition", "run already has a pending effect");
			return { ...snapshot, pendingEffectId: requiredString(event.payload, "proposalId"), sequence: event.sequence, updatedAt: event.timestamp };
		case "run.waiting-human":
			if (snapshot.pendingEffectId !== requiredString(event.payload, "proposalId"))
				throw new RunJournalError("invalid-transition", "waiting-human must reference the pending effect");
			return transition(snapshot, "waiting-human", event);
		case "run.effect-approved":
		case "run.effect-rejected":
		case "run.effect-expired":
		case "run.effect-execution-started":
			if (snapshot.pendingEffectId !== requiredString(event.payload, "proposalId"))
				throw new RunJournalError("invalid-transition", "effect event must reference the pending effect");
			return { ...snapshot, sequence: event.sequence, updatedAt: event.timestamp };
		case "run.effect-completed":
		case "run.effect-failed":
			if (snapshot.pendingEffectId !== requiredString(event.payload, "proposalId"))
				throw new RunJournalError("invalid-transition", "effect event must reference the pending effect");
			return { ...snapshot, pendingEffectId: undefined, sequence: event.sequence, updatedAt: event.timestamp };
		case "run.resumed":
			if (snapshot.state !== "waiting-human") throw new RunJournalError("invalid-transition", "only waiting-human can resume");
			return { ...transition(snapshot, "running", event), pendingEffectId: snapshot.pendingEffectId };
		case "run.completed":
			if (snapshot.state !== "running") throw new RunJournalError("invalid-transition", "only a running run can complete");
			return transition(snapshot, "completed", event);
		case "run.failed":
			return { ...transition(snapshot, "failed", event), failure: typeof event.payload.reason === "string" ? event.payload.reason : "run failed" };
		case "run.cancelled":
			return transition(snapshot, "cancelled", event);
		case "run.created":
			throw new RunJournalError("invalid-transition", "run.created is emitted only by create");
	}
}
