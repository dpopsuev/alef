import type { Client } from "@libsql/client";
import type { SessionNameSource } from "@dpopsuev/alef-session/storage";
import {
	loadPlanPreview,
	projectTranscriptSlice,
	type SessionRecordProjection,
} from "@dpopsuev/alef-session/context";
import { SqliteAuthStore } from "./sqlite/auth.js";
import { SqliteDaemonRegistry } from "./sqlite/daemon.js";
import type { AuthStore, DaemonRegistry, SessionPreviewProvider, SessionStoreFactory, StorageFactory, SummaryStore } from "./interfaces.js";
import { parseEventPayload, PREVIEW_EVENT_SQL_FILTER, previewEventLimit } from "./sqlite/event-load.js";
import { SqliteSessionStore } from "./sqlite/session.js";
import { SqliteSummaryStore } from "./sqlite/summary.js";

/**
 *
 */
function parseNameSource(value: unknown): SessionNameSource | undefined {
	return value === "user" || value === "auto" ? value : undefined;
}

/**
 * Load transcript-relevant events for picker preview — filtered + turn-bounded,
 * never materializes context.assemble / checkpoint blobs.
 */
async function loadSessionEventProjections(
	client: Client,
	sessionId: string,
	maxTurns: number,
): Promise<{ cwd: string | undefined; events: SessionRecordProjection[] }> {
	const meta = await client.execute({
		sql: "SELECT cwd FROM sessions WHERE id = ?",
		args: [sessionId],
	});
	const cwd = typeof meta.rows[0]?.cwd === "string" ? meta.rows[0].cwd : undefined;

	const limit = previewEventLimit(maxTurns);
	const result = await client.execute({
		sql: `SELECT bus, type, payload FROM events
			WHERE session_id = ?
			AND (${PREVIEW_EVENT_SQL_FILTER})
			ORDER BY rowid DESC LIMIT ?`,
		args: [sessionId, limit],
	});

	const events = [...result.rows].reverse().map((row) => {
		const bus = typeof row.bus === "string" ? row.bus : "";
		const type = typeof row.type === "string" ? row.type : "";
		const rawPayload = typeof row.payload === "string" ? row.payload : "{}";
		return { bus, type, payload: parseEventPayload(rawPayload, type) };
	});

	return { cwd, events };
}

/**
 *
 */
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
			listAll: () => SqliteSessionStore.listAll(this.client),
			prune: (cwd) => SqliteSessionStore.prune(this.client, cwd),
		};
	}

	sessionPreview(): SessionPreviewProvider {
		return {
			getSessionName: async (sessionId) => {
				const r = await this.client.execute({ sql: "SELECT name FROM sessions WHERE id = ?", args: [sessionId] });
				const name = r.rows[0]?.name;
				return typeof name === "string" ? name : undefined;
			},
			getSessionNameSource: async (sessionId) => {
				const r = await this.client.execute({
					sql: "SELECT name_source FROM sessions WHERE id = ?",
					args: [sessionId],
				});
				return parseNameSource(r.rows[0]?.name_source);
			},
			getSessionPreview: async (sessionId, maxTurns) => {
				const { cwd, events } = await loadSessionEventProjections(this.client, sessionId, maxTurns);
				const plan = await loadPlanPreview(cwd);
				return projectTranscriptSlice(events, maxTurns, plan ? { plan } : undefined);
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

	database(): Client {
		return this.client;
	}

	close(): void {
		this.client.close();
	}
}
