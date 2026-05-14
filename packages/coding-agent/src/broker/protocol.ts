/**
 * IPC protocol between agent processes and the supervisor broker.
 *
 * Communication uses Node's built-in IPC channel (fd 3 via stdio: 'ipc').
 * Messages are serialized automatically by Node — no manual JSONL needed.
 *
 * The supervisor is the single process owner. Agents never spawn children
 * directly. Instead they send spawn requests to the supervisor, which
 * manages the full lifecycle of every agent process.
 */

// ---------------------------------------------------------------------------
// Agent → Supervisor (requests)
// ---------------------------------------------------------------------------

export interface SpawnRequest {
	type: "spawn";
	/** Unique request ID (agent-assigned, used to correlate responses) */
	id: string;
	/** Spawn configuration */
	config: SpawnConfig;
}

/**
 * Restart policy (inspired by Erlang/OTP):
 *   - permanent: always restart on exit (long-lived services)
 *   - transient: restart only on abnormal exit (exit code != 0)
 *   - temporary: never restart (one-shot tasks) — default
 */
export type RestartPolicy = "permanent" | "transient" | "temporary";

export interface SpawnConfig {
	/** Human-readable name for this agent (e.g., "reviewer", "scout") */
	name: string;
	/** Task prompt to send to the spawned agent */
	prompt: string;
	/** Model override (e.g., "anthropic/claude-sonnet-4") */
	model?: string;
	/** System prompt to append */
	systemPrompt?: string;
	/** Tool allowlist */
	tools?: string[];
	/** Working directory override */
	cwd?: string;
	/** Whether to run in the background (async) */
	background?: boolean;
	/** Session file to resume from (for stateful agents) */
	sessionFile?: string;
	/** Timeout in ms (default: no timeout) */
	timeout?: number;
	/**
	 * Restart policy (default: "temporary" — never restart).
	 * "permanent" always restarts, "transient" restarts only on crash.
	 */
	restart?: RestartPolicy;
	/**
	 * Shutdown timeout in ms (default: 5000).
	 * How long to wait for graceful shutdown before SIGKILL.
	 */
	shutdownTimeout?: number;
}

export interface KillRequest {
	type: "kill";
	/** ID of the spawn request to kill */
	id: string;
}

export interface StatusRequest {
	type: "status";
}

export interface RebuildRequest {
	type: "rebuild";
	/** Current session file to restore after rebuild */
	sessionFile?: string;
}

export type UpdateScope = "rebuild" | "packages" | "self";

export interface UpdateRequest {
	type: "update";
	scope: UpdateScope;
	updateId: string;
	/** Current session file to restore after update */
	sessionFile?: string;
}

export interface HandoffAckRequest {
	type: "handoff_ack";
	updateId: string;
}

export type AgentToSupervisor =
	| SpawnRequest
	| KillRequest
	| StatusRequest
	| RebuildRequest
	| UpdateRequest
	| HandoffAckRequest;

// ---------------------------------------------------------------------------
// Supervisor → Agent (responses & events)
// ---------------------------------------------------------------------------

export interface SpawnStarted {
	type: "spawn_started";
	id: string;
	pid: number;
}

export interface SpawnEvent {
	type: "spawn_event";
	id: string;
	/** JSONL event from the spawned agent's stdout */
	event: unknown;
}

export interface SpawnComplete {
	type: "spawn_complete";
	id: string;
	exitCode: number;
	/** Final assistant text output */
	output: string;
	/** Stderr from the spawned process */
	stderr: string;
	/** Aggregated usage stats */
	usage: SpawnUsage;
}

export interface SpawnError {
	type: "spawn_error";
	id: string;
	error: string;
}

export interface StatusResponse {
	type: "status_response";
	agents: Array<{
		id: string;
		name: string;
		pid: number;
		running: boolean;
		startedAt: number;
		restart: RestartPolicy;
		restartCount: number;
	}>;
}

export interface RebuildAck {
	type: "rebuild_ack";
}

export type SupervisorToAgent = SpawnStarted | SpawnEvent | SpawnComplete | SpawnError | StatusResponse | RebuildAck;

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface SpawnUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isAgentToSupervisor(msg: unknown): msg is AgentToSupervisor {
	return (
		typeof msg === "object" &&
		msg !== null &&
		"type" in msg &&
		["spawn", "kill", "status", "rebuild", "update", "handoff_ack"].includes((msg as { type: string }).type)
	);
}

export function isSupervisorToAgent(msg: unknown): msg is SupervisorToAgent {
	return (
		typeof msg === "object" &&
		msg !== null &&
		"type" in msg &&
		["spawn_started", "spawn_event", "spawn_complete", "spawn_error", "status_response", "rebuild_ack"].includes(
			(msg as { type: string }).type,
		)
	);
}
