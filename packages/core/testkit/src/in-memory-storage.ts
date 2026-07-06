// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { randomUUID } from "node:crypto";
import type {
	AuthStore,
	DaemonEntry,
	DaemonRegistry,
	SessionStoreFactory,
	SessionSummary,
	StorageFactory,
	SummaryStore,
} from "@dpopsuev/alef-storage";
import { InMemorySessionStore } from "./in-memory-session-store.js";

/**
 *
 */
export class InMemoryDaemonRegistry implements DaemonRegistry {
	private readonly entries = new Map<string, DaemonEntry>();

	// eslint-disable-next-line @typescript-eslint/require-await
	async register(entry: DaemonEntry): Promise<void> {
		this.entries.set(entry.sessionId, { ...entry, lastHeartbeat: Date.now() });
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async unregister(sessionId: string): Promise<void> {
		this.entries.delete(sessionId);
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async heartbeat(sessionId: string): Promise<void> {
		const e = this.entries.get(sessionId);
		if (e) this.entries.set(sessionId, { ...e, lastHeartbeat: Date.now() });
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async get(sessionId: string): Promise<DaemonEntry | undefined> {
		return this.entries.get(sessionId);
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async list(): Promise<DaemonEntry[]> {
		return [...this.entries.values()].sort((a, b) => b.startedAt - a.startedAt);
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async findByCwd(cwd: string): Promise<DaemonEntry | undefined> {
		return [...this.entries.values()].find((e) => e.cwd === cwd);
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async findLatest(): Promise<DaemonEntry | undefined> {
		const sorted = [...this.entries.values()].sort((a, b) => b.startedAt - a.startedAt);
		return sorted[0];
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async prune(): Promise<number> {
		return 0;
	}
}

/**
 *
 */
export class InMemorySummaryStore implements SummaryStore {
	private readonly summaries = new Map<string, SessionSummary>();

	// eslint-disable-next-line @typescript-eslint/require-await
	async write(summary: SessionSummary): Promise<void> {
		this.summaries.set(summary.id, summary);
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async get(sessionId: string): Promise<SessionSummary | undefined> {
		return this.summaries.get(sessionId);
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async latest(): Promise<SessionSummary | undefined> {
		const all = [...this.summaries.values()];
		return all[all.length - 1];
	}
}

/**
 *
 */
export class InMemoryAuthStore implements AuthStore {
	private readonly keys = new Map<string, string>();

	// eslint-disable-next-line @typescript-eslint/require-await
	async get(provider: string): Promise<string | undefined> {
		return this.keys.get(provider);
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async set(provider: string, key: string): Promise<void> {
		this.keys.set(provider, key);
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async remove(provider: string): Promise<void> {
		this.keys.delete(provider);
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async list(): Promise<Array<{ provider: string; type: string }>> {
		return [...this.keys.keys()].map((p) => ({ provider: p, type: "api_key" }));
	}
}

/**
 *
 */
export class InMemorySessionStoreFactory implements SessionStoreFactory {
	private readonly stores = new Map<string, InMemorySessionStore>();

	// eslint-disable-next-line @typescript-eslint/require-await
	async create(): Promise<InMemorySessionStore> {
		const store = new InMemorySessionStore();
		this.stores.set(store.id, store);
		return store;
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async resume(_cwd: string, id: string): Promise<InMemorySessionStore> {
		const store = this.stores.get(id);
		if (!store) throw new Error(`Session ${id} not found`);
		return store;
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async resumeLatest(): Promise<InMemorySessionStore | null> {
		const all = [...this.stores.values()];
		return all[all.length - 1] ?? null;
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async list(): Promise<Array<{ id: string; path: string; mtime: Date }>> {
		return [...this.stores.values()].map((s) => ({ id: s.id, path: s.path, mtime: new Date() }));
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async prune(): Promise<number> {
		return 0;
	}
}

/**
 *
 */
export function createInMemoryStorage(): StorageFactory {
	const daemon = new InMemoryDaemonRegistry();
	const summary = new InMemorySummaryStore();
	const auth = new InMemoryAuthStore();
	const sessions = new InMemorySessionStoreFactory();

	return {
		daemonRegistry: () => daemon,
		summaryStore: () => summary,
		authStore: () => auth,
		sessions,
	};
}
