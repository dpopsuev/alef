import type { Client } from "@libsql/client";
import type { SessionStore } from "@dpopsuev/alef-session";
import { SqliteAuthStore } from "./auth.js";
import { SqliteDaemonStore } from "./daemon.js";
import { SqliteDiscourseStore } from "./discourse.js";
import type { AuthStore, DaemonStore, DiscourseStore, SessionStoreFactory, StorageFactory, SummaryStore } from "./interfaces.js";
import { SqliteSessionStore } from "./session-store.js";
import { SqliteSummaryStore } from "./summary.js";

export class SqliteStorageFactory implements StorageFactory {
	private readonly client: Client;
	readonly sessions: SessionStoreFactory;

	constructor(client: Client) {
		this.client = client;
		this.sessions = {
			create: (cwd) => SqliteSessionStore.create(this.client, cwd),
			resume: (cwd, id) => SqliteSessionStore.resume(this.client, cwd, id),
			resumeLatest: (cwd) => SqliteSessionStore.resumeLatest(this.client, cwd),
			list: (cwd) => SqliteSessionStore.list(this.client, cwd),
			prune: (cwd) => SqliteSessionStore.prune(this.client, cwd),
		};
	}

	daemonStore(): DaemonStore {
		return new SqliteDaemonStore(this.client);
	}

	summaryStore(): SummaryStore {
		return new SqliteSummaryStore(this.client);
	}

	discourseStore(sessionId: string): DiscourseStore {
		return new SqliteDiscourseStore(this.client, sessionId);
	}

	authStore(): AuthStore {
		return new SqliteAuthStore(this.client);
	}

	close(): void {
		this.client.close();
	}
}
