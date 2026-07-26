import {
	applyRunEvent,
	type CreateRunInput,
	type EffectProposal,
	type EffectProposalStatus,
	type RunAppendResult,
	type RunEvent,
	type RunEventInput,
	type RunJournal,
	RunJournalError,
	type RunSnapshot,
} from "../run-journal.js";

const MAX_EVENT_PAGE = 1_000;

/** In-memory RunJournal used by production-shaped test hosts. */
export class InMemoryRunJournal implements RunJournal {
	private readonly snapshots = new Map<string, RunSnapshot>();
	private readonly eventLog = new Map<string, RunEvent[]>();
	private readonly proposals = new Map<string, EffectProposal>();

	create(input: CreateRunInput): Promise<RunSnapshot> {
		if (this.snapshots.has(input.runId)) throw new RunJournalError("already-exists", `run ${input.runId} already exists`);
		const timestamp = input.timestamp ?? Date.now();
		const snapshot: RunSnapshot = {
			id: input.runId,
			sessionId: input.sessionId,
			state: "created",
			sequence: 1,
			policy: structuredClone(input.policy),
			budget: { toolCalls: 0, startedAt: timestamp },
			activeTools: 0,
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		const event: RunEvent = {
			runId: input.runId,
			sequence: 1,
			type: "run.created",
			payload: { sessionId: input.sessionId, policy: structuredClone(input.policy) },
			timestamp,
		};
		this.snapshots.set(input.runId, snapshot);
		this.eventLog.set(input.runId, [event]);
		return Promise.resolve(structuredClone(snapshot));
	}

	get(runId: string): Promise<RunSnapshot | undefined> {
		const snapshot = this.snapshots.get(runId);
		return Promise.resolve(snapshot ? structuredClone(snapshot) : undefined);
	}

	append(runId: string, expectedSequence: number, input: RunEventInput): Promise<RunAppendResult> {
		const snapshot = this.snapshots.get(runId);
		if (!snapshot) throw new RunJournalError("not-found", `run ${runId} not found`);
		if (snapshot.sequence !== expectedSequence)
			throw new RunJournalError("sequence-conflict", `run ${runId} is at sequence ${snapshot.sequence}, not ${expectedSequence}`);
		const event: RunEvent = { ...structuredClone(input), runId, sequence: expectedSequence + 1, timestamp: Date.now() };
		const next = applyRunEvent(snapshot, event);
		this.updateProposal(event);
		this.snapshots.set(runId, next);
		this.eventLog.get(runId)?.push(event);
		return Promise.resolve({ event: structuredClone(event), snapshot: structuredClone(next) });
	}

	events(runId: string, afterSequence: number, limit: number): Promise<RunEvent[]> {
		if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVENT_PAGE)
			throw new Error(`run event limit must be between 1 and ${MAX_EVENT_PAGE}`);
		return Promise.resolve(
			structuredClone((this.eventLog.get(runId) ?? []).filter((event) => event.sequence > afterSequence).slice(0, limit)),
		);
	}

	getEffectProposal(runId: string, proposalId: string): Promise<EffectProposal | undefined> {
		const proposal = this.proposals.get(proposalId);
		return Promise.resolve(proposal?.runId === runId ? structuredClone(proposal) : undefined);
	}

	private updateProposal(event: RunEvent): void {
		if (!event.type.startsWith("run.effect-")) return;
		const proposalId = typeof event.payload.proposalId === "string" ? event.payload.proposalId : "";
		if (!proposalId) throw new RunJournalError("invalid-transition", "proposalId is required");
		if (event.type === "run.effect-proposed") {
			this.proposals.set(proposalId, {
				id: proposalId,
				runId: event.runId,
				commandName: String(event.payload.commandName),
				commandVersion: Number(event.payload.commandVersion),
				input: structuredClone(event.payload.input),
				status: "pending",
				createdAt: event.timestamp,
				updatedAt: event.timestamp,
			});
			return;
		}
		const proposal = this.proposals.get(proposalId);
		if (!proposal) throw new RunJournalError("invalid-transition", `effect proposal ${proposalId} not found`);
		const statusByType: Partial<Record<RunEvent["type"], EffectProposalStatus>> = {
			"run.effect-approved": "approved",
			"run.effect-rejected": "rejected",
			"run.effect-expired": "expired",
			"run.effect-execution-started": "executing",
			"run.effect-completed": "completed",
			"run.effect-failed": "failed",
		};
		const status = statusByType[event.type];
		if (!status) return;
		this.proposals.set(proposalId, {
			...proposal,
			status,
			input: Object.hasOwn(event.payload, "input") ? structuredClone(event.payload.input) : proposal.input,
			reviewer: typeof event.payload.reviewer === "string" ? event.payload.reviewer : proposal.reviewer,
			updatedAt: event.timestamp,
		});
	}
}
