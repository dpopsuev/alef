import { randomUUID } from "node:crypto";
import {
	type CapabilityExecutionPolicy,
	CapabilityExecutionPolicyError,
	type CapabilityExecutionRequest,
} from "@dpopsuev/alef-kernel/capabilities";
import { defineEvent, type EventHub } from "@dpopsuev/alef-kernel/events";
import { traceEvent } from "@dpopsuev/alef-kernel/log";
import {
	type ConversationTrigger,
	type EffectProposal,
	type RunAppendResult,
	type RunEvent,
	type RunEventInput,
	type RunJournal,
	RunJournalError,
	type RunPolicyDefinition,
	type RunSnapshot,
} from "@dpopsuev/alef-storage/run-journal";
import { z } from "zod";

/** Fans out only events already committed to the RunJournal. */
export const RunCommitted = defineEvent({
	type: "run.committed",
	version: 1,
	payload: z.object({
		type: z.string(),
		sequence: z.number().int().positive(),
		event: z.custom<RunEvent>(),
		snapshot: z.custom<RunSnapshot>(),
	}),
	overflow: "reject",
});

/** Reports a stable policy failure code to command callers. */
export class RunPolicyError extends CapabilityExecutionPolicyError {}

/** Returns the durable proposal identity instead of holding an in-memory promise. */
export class RunWaitingForHumanError extends RunPolicyError {
	constructor(readonly proposalId: string) {
		super("waiting-human", `run is waiting for approval of effect proposal ${proposalId}`);
		this.name = "RunWaitingForHumanError";
	}
}

const APPEND_RETRIES = 5;

/** Governs command execution from durable run state. */
export class DurableRunPolicy implements CapabilityExecutionPolicy {
	constructor(
		private readonly journal: RunJournal,
		private readonly eventHub?: EventHub,
	) {}

	async start(
		runId: string,
		sessionId: string,
		policy: RunPolicyDefinition,
		conversationTrigger?: ConversationTrigger,
	): Promise<RunSnapshot> {
		const existing = await this.journal.get(runId);
		if (existing) return existing;
		const created = await this.journal.create({ runId, sessionId, policy, conversationTrigger });
		const createdEvent = (await this.journal.events(runId, 0, 1))[0];
		if (createdEvent) await this.publish(createdEvent, created);
		return (await this.commit(runId, { type: "run.started", payload: {} })).snapshot;
	}

	async execute(request: CapabilityExecutionRequest, invoke: (input: unknown) => Promise<unknown>): Promise<unknown> {
		const runId = request.options.runId;
		if (!runId) return invoke(request.input);
		const snapshot = await this.requireActive(runId);
		if (request.command.effect !== "external" || snapshot.policy.externalEffects === "allow") {
			return this.executeTool(runId, request, request.input, invoke);
		}

		const proposalId = request.options.effectProposalId;
		if (!proposalId) {
			if (snapshot.pendingEffectId) throw new RunWaitingForHumanError(snapshot.pendingEffectId);
			const id = randomUUID();
			await this.commit(runId, {
				type: "run.effect-proposed",
				correlationId: request.options.correlationId,
				payload: {
					proposalId: id,
					commandName: request.command.name,
					commandVersion: request.command.version,
					input: request.input,
				},
			});
			await this.commit(runId, {
				type: "run.waiting-human",
				correlationId: request.options.correlationId,
				payload: { proposalId: id },
			});
			throw new RunWaitingForHumanError(id);
		}

		const proposal = await this.requireApprovedProposal(runId, proposalId, request);
		const effectiveInput = request.command.input.safeParse(proposal.input);
		if (!effectiveInput.success) throw new RunPolicyError("invalid-effect-input", "approved effect input is invalid");
		await this.checkBudget(runId);
		await this.commit(runId, {
			type: "run.effect-execution-started",
			correlationId: request.options.correlationId,
			payload: { proposalId },
		});
		try {
			const output = await this.executeTool(runId, request, effectiveInput.data, invoke);
			await this.commit(runId, {
				type: "run.effect-completed",
				correlationId: request.options.correlationId,
				payload: { proposalId },
			});
			return output;
		} catch (error) {
			await this.commit(runId, {
				type: "run.effect-failed",
				correlationId: request.options.correlationId,
				payload: { proposalId, reason: error instanceof Error ? error.message : String(error) },
			});
			throw error;
		}
	}

	async approveEffect(runId: string, proposalId: string, reviewer: string, input?: unknown): Promise<RunSnapshot> {
		const proposal = await this.requirePendingProposal(runId, proposalId);
		await this.commit(runId, {
			type: "run.effect-approved",
			payload: { proposalId, reviewer, input: input ?? proposal.input },
		});
		return (await this.commit(runId, { type: "run.resumed", payload: { proposalId } })).snapshot;
	}

	async rejectEffect(runId: string, proposalId: string, reviewer: string, reason?: string): Promise<RunSnapshot> {
		await this.requirePendingProposal(runId, proposalId);
		await this.commit(runId, { type: "run.effect-rejected", payload: { proposalId, reviewer, reason } });
		return (await this.commit(runId, { type: "run.failed", payload: { reason: reason ?? "effect rejected" } })).snapshot;
	}

	async expireEffect(runId: string, proposalId: string): Promise<RunSnapshot> {
		await this.requirePendingProposal(runId, proposalId);
		await this.commit(runId, { type: "run.effect-expired", payload: { proposalId } });
		return (await this.commit(runId, { type: "run.failed", payload: { reason: "effect approval expired" } })).snapshot;
	}

	async complete(runId: string): Promise<RunSnapshot> {
		const snapshot = await this.require(runId);
		if (snapshot.state === "waiting-human") return snapshot;
		if (snapshot.state !== "running") throw new RunPolicyError("invalid-run-state", `run ${runId} is ${snapshot.state}`);
		return (await this.commit(runId, { type: "run.completed", payload: {} })).snapshot;
	}

	async fail(runId: string, reason: string): Promise<RunSnapshot> {
		const snapshot = await this.require(runId);
		if (snapshot.state === "waiting-human" || ["completed", "failed", "cancelled"].includes(snapshot.state)) return snapshot;
		return (await this.commit(runId, { type: "run.failed", payload: { reason } })).snapshot;
	}

	async cancel(runId: string): Promise<RunSnapshot> {
		return (await this.commit(runId, { type: "run.cancelled", payload: {} })).snapshot;
	}

	private async executeTool(
		runId: string,
		request: CapabilityExecutionRequest,
		input: unknown,
		invoke: (input: unknown) => Promise<unknown>,
	): Promise<unknown> {
		await this.checkBudget(runId);
		await this.consumeBudget(runId, request);
		await this.commit(runId, {
			type: "run.waiting-tool",
			correlationId: request.options.correlationId,
			payload: { commandName: request.command.name, toolCallId: request.options.toolCallId },
		});
		try {
			const output = await invoke(input);
			await this.commit(runId, {
				type: "run.tool-completed",
				correlationId: request.options.correlationId,
				payload: { commandName: request.command.name, toolCallId: request.options.toolCallId },
			});
			return output;
		} catch (error) {
			await this.commit(runId, {
				type: "run.tool-failed",
				correlationId: request.options.correlationId,
				payload: {
					commandName: request.command.name,
					toolCallId: request.options.toolCallId,
					reason: error instanceof Error ? error.message : String(error),
				},
			});
			throw error;
		}
	}

	private async consumeBudget(runId: string, request: CapabilityExecutionRequest): Promise<void> {
		try {
			await this.commit(runId, {
				type: "run.budget-consumed",
				correlationId: request.options.correlationId,
				payload: { commandName: request.command.name },
			});
		} catch (error) {
			if (!(error instanceof RunJournalError) || error.code !== "invalid-transition") throw error;
			await this.commit(runId, {
				type: "run.budget-exceeded",
				correlationId: request.options.correlationId,
				payload: { commandName: request.command.name, reason: error.message },
			});
			throw new RunPolicyError("budget-exceeded", `run ${runId} ${error.message}`);
		}
	}

	private async checkBudget(runId: string): Promise<void> {
		const snapshot = await this.requireActive(runId);
		const { maxToolCalls, maxElapsedMs } = snapshot.policy.budget;
		if (maxToolCalls !== undefined && snapshot.budget.toolCalls >= maxToolCalls) {
			await this.commit(runId, { type: "run.budget-exceeded", payload: { reason: `maxToolCalls (${maxToolCalls}) exceeded` } });
			throw new RunPolicyError("budget-exceeded", `run ${runId} exceeded maxToolCalls (${maxToolCalls})`);
		}
		if (maxElapsedMs !== undefined && Date.now() - snapshot.budget.startedAt >= maxElapsedMs) {
			await this.commit(runId, { type: "run.budget-exceeded", payload: { reason: `maxElapsedMs (${maxElapsedMs}) exceeded` } });
			throw new RunPolicyError("budget-exceeded", `run ${runId} exceeded maxElapsedMs (${maxElapsedMs})`);
		}
	}

	private async requireActive(runId: string): Promise<RunSnapshot> {
		const snapshot = await this.require(runId);
		if (snapshot.state !== "running" && snapshot.state !== "waiting-tool")
			throw new RunPolicyError("invalid-run-state", `run ${runId} is ${snapshot.state}`);
		return snapshot;
	}

	private async require(runId: string): Promise<RunSnapshot> {
		const snapshot = await this.journal.get(runId);
		if (!snapshot) throw new RunPolicyError("run-not-found", `run ${runId} not found`);
		return snapshot;
	}

	private async requirePendingProposal(runId: string, proposalId: string): Promise<EffectProposal> {
		const proposal = await this.journal.getEffectProposal(runId, proposalId);
		if (!proposal || proposal.status !== "pending")
			throw new RunPolicyError("invalid-effect-state", `effect proposal ${proposalId} is not pending`);
		return proposal;
	}

	private async requireApprovedProposal(
		runId: string,
		proposalId: string,
		request: CapabilityExecutionRequest,
	): Promise<EffectProposal> {
		const proposal = await this.journal.getEffectProposal(runId, proposalId);
		if (!proposal) throw new RunPolicyError("effect-not-found", `effect proposal ${proposalId} not found`);
		if (proposal.commandName !== request.command.name || proposal.commandVersion !== request.command.version)
			throw new RunPolicyError("effect-mismatch", `effect proposal ${proposalId} does not match the command`);
		if (proposal.status === "executing")
			throw new RunPolicyError("effect-outcome-unknown", `effect proposal ${proposalId} may already have executed`);
		if (proposal.status !== "approved")
			throw new RunPolicyError("invalid-effect-state", `effect proposal ${proposalId} is ${proposal.status}`);
		return proposal;
	}

	private async commit(runId: string, input: RunEventInput): Promise<RunAppendResult> {
		for (let attempt = 0; attempt < APPEND_RETRIES; attempt++) {
			const snapshot = await this.require(runId);
			try {
				const result = await this.journal.append(runId, snapshot.sequence, input);
				await this.publish(result.event, result.snapshot);
				return result;
			} catch (error) {
				if (!(error instanceof RunJournalError) || error.code !== "sequence-conflict" || attempt === APPEND_RETRIES - 1)
					throw error;
			}
		}
		throw new Error("unreachable");
	}

	private async publish(event: RunEvent, snapshot: RunSnapshot): Promise<void> {
		if (!this.eventHub) return;
		try {
			await this.eventHub.publish(
				RunCommitted,
				{ type: event.type, sequence: event.sequence, event, snapshot },
				{ correlationId: event.correlationId, scope: { runId: event.runId, sessionId: snapshot.sessionId } },
			);
		} catch (error) {
			traceEvent("run:event-delivery-failed", { runId: event.runId, sequence: event.sequence, error: String(error) });
		}
	}
}
