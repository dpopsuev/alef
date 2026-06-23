import { type Client, getDatabase, SqliteSessionStore } from "@dpopsuev/alef-storage";
export type SessionPicker = (sessions: Array<{ id: string; path: string; mtime: Date }>) => Promise<string | undefined>;

export interface LoadSessionArgs {
	cwd: string;
	resume: string | undefined;
	listSessions: boolean;
}

export async function getDb(): Promise<Client> {
	return getDatabase();
}

export async function loadSession(
	args: LoadSessionArgs,
	willUseTui: boolean,
	pickSession?: SessionPicker,
): Promise<SqliteSessionStore> {
	const db = await getDb();
	const pruned = await SqliteSessionStore.prune(db, args.cwd);
	if (pruned > 0) console.error(`[session] Pruned ${pruned} old session(s)`);
	if (args.listSessions) {
		const sessions = await SqliteSessionStore.list(db, args.cwd);
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
			? await SqliteSessionStore.resume(db, args.cwd, resumeId)
			: await SqliteSessionStore.resumeLatest(db, args.cwd);
		if (!store) {
			console.error("No session to resume. Start a new session first.");
			process.exit(1);
		}
		const turnCount = (await store.turns()).length;
		console.error(`[session] Resumed ${store.id} (${turnCount} turns)`);
		return store;
	}

	const existingSessions = willUseTui && pickSession ? await SqliteSessionStore.list(db, args.cwd) : [];
	const pickedId = existingSessions.length > 0 && pickSession ? await pickSession(existingSessions) : undefined;
	if (pickedId) {
		const store = await SqliteSessionStore.resume(db, args.cwd, pickedId);
		const turnCount = (await store.turns()).length;
		console.error(`[session] Resumed ${store.id} (${turnCount} turns)`);
		return store;
	}

	const store = await SqliteSessionStore.create(db, args.cwd);
	console.error(`[session] ${store.id}`);
	return store;
}
