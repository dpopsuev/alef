import type { Client } from "@libsql/client";
import type { SessionStore } from "@dpopsuev/alef-session";
import { SqliteAuthStore } from "./auth.js";
import { SqliteDaemonRegistry } from "./daemon.js";
import type { AuthStore, DaemonRegistry, SessionPreviewProvider, SessionStoreFactory, StorageFactory, SummaryStore } from "./interfaces.js";
import { SqliteSessionStore } from "./sqlite-session.js";
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

	sessionPreview(): SessionPreviewProvider {
		return {
			getSessionName: async (sessionId) => {
				const r = await this.client.execute({ sql: "SELECT name FROM sessions WHERE id = ?", args: [sessionId] });
				const name = r.rows[0]?.name;
				return name != null ? String(name) : undefined;
			},
			getSessionPreview: async (sessionId, maxLines) => {
				const r = await this.client.execute({
					sql: `SELECT bus, type, payload FROM events
						WHERE session_id = ? AND bus IN ('event', 'command', 'notification')
						AND type NOT IN ('adapter.loaded', 'llm.chunk', 'llm.checkpoint', 'llm.thinking', 'context.assemble')
						ORDER BY rowid DESC LIMIT ?`,
					args: [sessionId, maxLines * 3],
				});
				const lines: string[] = [];
				for (const row of [...r.rows].reverse()) {
					const bus = String(row.bus);
					const type = String(row.type);
					const payload = JSON.parse(String(row.payload)) as Record<string, unknown>;
					if (bus === "event" && type === "llm.input") {
						const text = typeof payload.text === "string" ? payload.text : "";
						if (text) lines.push(`  ▸ ${text.slice(0, 70).replace(/\n/g, " ")}`);
					} else if ((bus === "notification" && type === "llm.result") || (bus === "command" && type === "llm.response")) {
						const text = typeof payload.text === "string" ? payload.text : "";
						if (text) lines.push(`  ◂ ${text.slice(0, 70).replace(/\n/g, " ")}`);
					} else if (bus === "command" && !type.startsWith("llm.") && !type.startsWith("context.")) {
						lines.push(`  ● ${type}`);
					}
				}
				return lines.slice(-maxLines);
			},
		};
	}

	daemonRegistry(): DaemonRegistry {
		return new SqliteDaemonRegistry(this.client);
	}

	summaryStore(): SummaryStore {
		return new SqliteSummaryStore(this.client);
	}

	authStore(): AuthStore {
		return new SqliteAuthStore(this.client);
	}

	close(): void {
		this.client.close();
	}
}
