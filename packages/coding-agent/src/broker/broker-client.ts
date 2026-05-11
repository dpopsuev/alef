/**
 * BrokerClient — agent-side interface to the supervisor broker.
 *
 * Extensions use this to spawn subagents, check status, and request rebuilds.
 * Communication uses Node's IPC channel (process.send / process.on("message")).
 *
 * When not running under a supervisor (no IPC channel), the client falls back
 * to direct child_process.spawn — same behavior as today, no broker.
 */

import { randomUUID } from "node:crypto";
import type { SpawnComplete, SpawnConfig, SupervisorToAgent } from "./protocol.js";

type SpawnCallback = {
	onEvent?: (event: unknown) => void;
	onComplete: (result: SpawnComplete) => void;
	onError: (error: string) => void;
};

export class BrokerClient {
	private pending = new Map<string, SpawnCallback>();
	private connected = false;

	constructor() {
		this.connected = typeof process.send === "function";
		if (this.connected) {
			process.on("message", (msg: unknown) => this.handleMessage(msg as SupervisorToAgent));
		}
	}

	/** Whether we're running under a supervisor with IPC */
	get isSupervised(): boolean {
		return this.connected;
	}

	/**
	 * Spawn a subagent through the broker.
	 * Returns a promise that resolves with the spawn result.
	 */
	spawn(config: SpawnConfig, onEvent?: (event: unknown) => void): Promise<SpawnComplete> {
		const id = randomUUID();

		if (!this.connected) {
			return Promise.reject(new Error("Not running under supervisor. Use direct spawn instead."));
		}

		return new Promise((resolve, reject) => {
			this.pending.set(id, {
				onEvent,
				onComplete: resolve,
				onError: (error) => reject(new Error(error)),
			});

			process.send!({ type: "spawn", id, config });
		});
	}

	/** Kill a running subagent by its spawn ID */
	kill(id: string): void {
		if (this.connected) {
			process.send!({ type: "kill", id });
		}
	}

	/** Get status of all managed agents */
	async status(): Promise<Array<{ id: string; name: string; pid: number; running: boolean; startedAt: number }>> {
		if (!this.connected) return [];

		return new Promise((resolve) => {
			const handler = (msg: unknown) => {
				const m = msg as SupervisorToAgent;
				if (m.type === "status_response") {
					process.removeListener("message", handler);
					resolve(m.agents);
				}
			};
			process.on("message", handler);
			process.send!({ type: "status" });
		});
	}

	/** Request a rebuild via the supervisor */
	requestRebuild(sessionFile?: string): void {
		if (this.connected) {
			process.send!({ type: "rebuild", sessionFile });
		}
	}

	/** Clean up listeners */
	dispose(): void {
		this.pending.clear();
	}

	private handleMessage(msg: SupervisorToAgent): void {
		switch (msg.type) {
			case "spawn_started":
				// Informational — agent is running
				break;

			case "spawn_event": {
				const cb = this.pending.get(msg.id);
				if (cb?.onEvent) {
					cb.onEvent(msg.event);
				}
				break;
			}

			case "spawn_complete": {
				const cb = this.pending.get(msg.id);
				if (cb) {
					this.pending.delete(msg.id);
					cb.onComplete(msg);
				}
				break;
			}

			case "spawn_error": {
				const cb = this.pending.get(msg.id);
				if (cb) {
					this.pending.delete(msg.id);
					cb.onError(msg.error);
				}
				break;
			}

			case "rebuild_ack":
				// Supervisor acknowledged the rebuild — we'll be killed soon
				break;

			case "status_response":
				// Handled by the status() promise
				break;
		}
	}
}

/** Singleton — one broker client per agent process */
let _instance: BrokerClient | undefined;

export function getBrokerClient(): BrokerClient {
	if (!_instance) {
		_instance = new BrokerClient();
	}
	return _instance;
}
