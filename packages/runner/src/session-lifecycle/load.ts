import { getDatabase, SqliteSessionStore } from "@dpopsuev/alef-storage";
import type Database from "better-sqlite3";
import type { Args } from "../args.js";
import { pickSession } from "./picker.js";

export function getDb(): Database.Database {
	return getDatabase();
}

export async function loadSession(args: Args, willUseTui: boolean): Promise<SqliteSessionStore> {
	const db = getDb();
	const pruned = SqliteSessionStore.prune(db, args.cwd);
	if (pruned > 0) console.error(`[session] Pruned ${pruned} old session(s)`);
	if (args.listSessions) {
		const sessions = SqliteSessionStore.list(db, args.cwd);
		if (sessions.length === 0) {
			console.log("No sessions for", args.cwd);
		} else {
			for (const session of sessions) {
				console.log(`${session.id}  ${session.mtime.toISOString().replace("T", " ").slice(0, 16)}`);
			}
		}
		process.exit(0);
	}

	if (args.resume) {
		const resumeId = args.resume === "last" ? undefined : args.resume;
		const store = resumeId
			? SqliteSessionStore.resume(db, args.cwd, resumeId)
			: SqliteSessionStore.resumeLatest(db, args.cwd);
		if (!store) {
			console.error("No session to resume. Start a new session first.");
			process.exit(1);
		}
		const turnCount = (await store.turns()).length;
		console.error(`[session] Resumed ${store.id} (${turnCount} turns)`);
		return store;
	}

	const existingSessions = willUseTui ? SqliteSessionStore.list(db, args.cwd) : [];
	const pickedId = existingSessions.length > 0 ? await pickSession(existingSessions) : undefined;
	if (pickedId) {
		const store = SqliteSessionStore.resume(db, args.cwd, pickedId);
		const turnCount = (await store.turns()).length;
		console.error(`[session] Resumed ${store.id} (${turnCount} turns)`);
		return store;
	}

	const store = SqliteSessionStore.create(db, args.cwd);
	console.error(`[session] ${store.id}`);
	return store;
}
