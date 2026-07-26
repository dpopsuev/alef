import type { Client, Transaction } from "@libsql/client";
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
const MAX_PENDING_WRITES = 256;
type WriteQueue = { tail: Promise<void>; pending: number };
const writeQueues = new WeakMap<Client, WriteQueue>();

/** Serializes one client's writes so concurrent tools cannot contend on SQLite transactions. */
function enqueueWrite<T>(client: Client, operation: () => Promise<T>): Promise<T> {
	let queue = writeQueues.get(client);
	if (!queue) {
		queue = { tail: Promise.resolve(), pending: 0 };
		writeQueues.set(client, queue);
	}
	if (queue.pending >= MAX_PENDING_WRITES) return Promise.reject(new Error("run journal write queue capacity reached"));
	queue.pending += 1;
	const result = queue.tail.then(operation);
	queue.tail = result.then(
		() => undefined,
		() => undefined,
	);
	return result.finally(() => {
		queue.pending -= 1;
	});
}
const RUN_EVENT_TYPES = [
	"run.created",
	"run.started",
	"run.waiting-tool",
	"run.tool-completed",
	"run.tool-failed",
	"run.budget-consumed",
	"run.budget-exceeded",
	"run.effect-proposed",
	"run.effect-approved",
	"run.effect-rejected",
	"run.effect-expired",
	"run.effect-execution-started",
	"run.effect-completed",
	"run.effect-failed",
	"run.waiting-human",
	"run.resumed",
	"run.completed",
	"run.failed",
	"run.cancelled",
] as const;
const EFFECT_STATUSES = ["pending", "approved", "rejected", "expired", "executing", "completed", "failed"] as const;

/** Parses journal-owned JSON after the schema fixes its storage type. */
function parseJson<T>(value: unknown, label: string): T {
	if (typeof value !== "string") throw new Error(`${label} is not text`);
	try {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- RunJournal owns both serialization and deserialization.
		return JSON.parse(value) as T;
	} catch (error) {
		throw new Error(`${label} is invalid JSON`, { cause: error });
	}
}

/** Rehydrates one snapshot row. */
function snapshotFromRow(row: Record<string, unknown>): RunSnapshot {
	return parseJson<RunSnapshot>(row.snapshot_json, "run snapshot");
}

/** Rejects event names not owned by the Run domain. */
function runEventType(value: unknown): RunEvent["type"] {
	const matched = RUN_EVENT_TYPES.find((type) => type === value);
	if (!matched) throw new Error(`unknown run event type: ${String(value)}`);
	return matched;
}

/** Rehydrates one sequenced event row. */
function eventFromRow(row: Record<string, unknown>): RunEvent {
	return {
		runId: String(row.run_id),
		sequence: Number(row.sequence),
		type: runEventType(row.type),
		payload: parseJson<Record<string, unknown>>(row.payload_json, "run event payload"),
		correlationId: typeof row.correlation_id === "string" ? row.correlation_id : undefined,
		timestamp: Number(row.timestamp),
	};
}

/** Rejects effect states outside the persisted state machine. */
function effectStatus(value: unknown): EffectProposalStatus {
	const matched = EFFECT_STATUSES.find((status) => status === value);
	if (!matched) throw new Error(`unknown effect proposal status: ${String(value)}`);
	return matched;
}

/** Rehydrates one external-effect proposal row. */
function proposalFromRow(row: Record<string, unknown>): EffectProposal {
	return {
		id: String(row.id),
		runId: String(row.run_id),
		commandName: String(row.command_name),
		commandVersion: Number(row.command_version),
		input: parseJson<unknown>(row.input_json, "effect proposal input"),
		status: effectStatus(row.status),
		reviewer: typeof row.reviewer === "string" ? row.reviewer : undefined,
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
	};
}

/** Rejects malformed proposal events before a transaction writes them. */
function requiredString(payload: Readonly<Record<string, unknown>>, field: string): string {
	const value = payload[field];
	if (typeof value !== "string" || value.length === 0) throw new RunJournalError("invalid-transition", `${field} is required`);
	return value;
}

/** Projects effect events into the restart-safe proposal table. */
async function updateProposal(transaction: Transaction, runId: string, event: RunEvent): Promise<void> {
	const proposalId = requiredString(event.payload, "proposalId");
	if (event.type === "run.effect-proposed") {
		const commandName = requiredString(event.payload, "commandName");
		const commandVersion = event.payload.commandVersion;
		if (!Number.isInteger(commandVersion) || Number(commandVersion) < 1)
			throw new RunJournalError("invalid-transition", "commandVersion must be a positive integer");
		await transaction.execute({
			sql: "INSERT INTO effect_proposals (id, run_id, command_name, command_version, input_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
			args: [proposalId, runId, commandName, Number(commandVersion), JSON.stringify(event.payload.input), event.timestamp, event.timestamp],
		});
		return;
	}
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
	const existing = await transaction.execute({
		sql: "SELECT status FROM effect_proposals WHERE run_id = ? AND id = ?",
		args: [runId, proposalId],
	});
	if (!existing.rows[0]) throw new RunJournalError("invalid-transition", `effect proposal ${proposalId} not found`);
	const reviewer = typeof event.payload.reviewer === "string" ? event.payload.reviewer : null;
	const inputJson = Object.hasOwn(event.payload, "input") ? JSON.stringify(event.payload.input) : null;
	await transaction.execute({
		sql: `UPDATE effect_proposals
			SET status = ?, reviewer = COALESCE(?, reviewer), input_json = COALESCE(?, input_json), updated_at = ?
			WHERE run_id = ? AND id = ?`,
		args: [status, reviewer, inputJson, event.timestamp, runId, proposalId],
	});
}

/** SQLite adapter for atomic Run event and snapshot persistence. */
export class SqliteRunJournal implements RunJournal {
	constructor(private readonly client: Client) {}

	create(input: CreateRunInput): Promise<RunSnapshot> {
		return enqueueWrite(this.client, () => this.createTransaction(input));
	}

	private async createTransaction(input: CreateRunInput): Promise<RunSnapshot> {
		if (!input.runId.trim() || !input.sessionId.trim()) throw new Error("runId and sessionId are required");
		const timestamp = input.timestamp ?? Date.now();
		const snapshot: RunSnapshot = {
			id: input.runId,
			sessionId: input.sessionId,
			state: "created",
			sequence: 1,
			policy: input.policy,
			budget: { toolCalls: 0, startedAt: timestamp },
			activeTools: 0,
			...(input.conversationTrigger ? { conversationTrigger: input.conversationTrigger } : {}),
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		const transaction = await this.client.transaction("write");
		try {
			const existing = await transaction.execute({ sql: "SELECT id FROM runs WHERE id = ?", args: [input.runId] });
			if (existing.rows[0]) throw new RunJournalError("already-exists", `run ${input.runId} already exists`);
			await transaction.execute({
				sql: "INSERT INTO runs (id, session_id, state, sequence, snapshot_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				args: [input.runId, input.sessionId, snapshot.state, snapshot.sequence, JSON.stringify(snapshot), timestamp, timestamp],
			});
			await transaction.execute({
				sql: "INSERT INTO run_events (run_id, sequence, type, payload_json, correlation_id, timestamp) VALUES (?, 1, 'run.created', ?, NULL, ?)",
				args: [input.runId, JSON.stringify({ sessionId: input.sessionId, policy: input.policy }), timestamp],
			});
			await transaction.commit();
			return snapshot;
		} catch (error) {
			await transaction.rollback();
			throw error;
		}
	}

	async get(runId: string): Promise<RunSnapshot | undefined> {
		const result = await this.client.execute({ sql: "SELECT snapshot_json FROM runs WHERE id = ?", args: [runId] });
		const row = result.rows[0];
		return row ? snapshotFromRow(row) : undefined;
	}

	append(runId: string, expectedSequence: number, input: RunEventInput): Promise<RunAppendResult> {
		return enqueueWrite(this.client, () => this.appendTransaction(runId, expectedSequence, input));
	}

	private async appendTransaction(runId: string, expectedSequence: number, input: RunEventInput): Promise<RunAppendResult> {
		const transaction = await this.client.transaction("write");
		try {
			const current = await transaction.execute({ sql: "SELECT snapshot_json FROM runs WHERE id = ?", args: [runId] });
			const row = current.rows[0];
			if (!row) throw new RunJournalError("not-found", `run ${runId} not found`);
			const snapshot = snapshotFromRow(row);
			if (snapshot.sequence !== expectedSequence)
				throw new RunJournalError("sequence-conflict", `run ${runId} is at sequence ${snapshot.sequence}, not ${expectedSequence}`);
			const event: RunEvent = {
				...input,
				runId,
				sequence: expectedSequence + 1,
				timestamp: Date.now(),
			};
			const next = applyRunEvent(snapshot, event);
			if (event.type.startsWith("run.effect-")) await updateProposal(transaction, runId, event);
			await transaction.execute({
				sql: "INSERT INTO run_events (run_id, sequence, type, payload_json, correlation_id, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
				args: [runId, event.sequence, event.type, JSON.stringify(event.payload), event.correlationId ?? null, event.timestamp],
			});
			const updated = await transaction.execute({
				sql: "UPDATE runs SET state = ?, sequence = ?, snapshot_json = ?, updated_at = ? WHERE id = ? AND sequence = ?",
				args: [next.state, next.sequence, JSON.stringify(next), next.updatedAt, runId, expectedSequence],
			});
			if (updated.rowsAffected !== 1)
				throw new RunJournalError("sequence-conflict", `run ${runId} changed during append`);
			await transaction.commit();
			return { event, snapshot: next };
		} catch (error) {
			await transaction.rollback();
			throw error;
		}
	}

	async events(runId: string, afterSequence: number, limit: number): Promise<RunEvent[]> {
		if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVENT_PAGE)
			throw new Error(`run event limit must be between 1 and ${MAX_EVENT_PAGE}`);
		const result = await this.client.execute({
			sql: "SELECT run_id, sequence, type, payload_json, correlation_id, timestamp FROM run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
			args: [runId, afterSequence, limit],
		});
		return result.rows.map(eventFromRow);
	}

	async getEffectProposal(runId: string, proposalId: string): Promise<EffectProposal | undefined> {
		const result = await this.client.execute({
			sql: "SELECT id, run_id, command_name, command_version, input_json, status, reviewer, created_at, updated_at FROM effect_proposals WHERE run_id = ? AND id = ?",
			args: [runId, proposalId],
		});
		const row = result.rows[0];
		return row ? proposalFromRow(row) : undefined;
	}
}
