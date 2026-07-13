import type { SessionStore } from "@dpopsuev/alef-session/storage";
import type { SessionPreviewProvider, SessionStoreFactory } from "@dpopsuev/alef-storage";

/** Callback that presents sessions for the cwd (and optional global scope) and returns an id. */
export type SessionPicker = (
	cwd: string,
	sessions: SessionStoreFactory,
	preview?: SessionPreviewProvider,
) => Promise<string | undefined>;

/** Subset of CLI args relevant to session loading and resumption. */
export interface LoadSessionArgs {
	cwd: string;
	resume: string | undefined;
	listSessions: boolean;
}

/** Resume, pick, or create a session store based on CLI args and available sessions. */
export async function loadSession(
	args: LoadSessionArgs,
	sessions: SessionStoreFactory,
	willUseTui: boolean,
	pickSession?: SessionPicker,
	preview?: SessionPreviewProvider,
): Promise<SessionStore> {
	const pruned = await sessions.prune(args.cwd);
	if (pruned > 0) console.error(`[session] Pruned ${pruned} old session(s)`);
	if (args.listSessions) {
		const list = await sessions.list(args.cwd);
		if (list.length === 0) {
			console.log("No sessions for", args.cwd);
		} else {
			for (const session of list) {
				const label = session.name ? `${session.id}  ${session.name}` : session.id;
				console.log(`${label}  ${session.mtime.toISOString().replace("T", " ").slice(0, 16)}`);
			}
		}
		process.exit(0);
	}

	if (args.resume) {
		const resumeId = args.resume === "last" ? undefined : args.resume;
		const store = resumeId ? await sessions.resume(args.cwd, resumeId) : await sessions.resumeLatest(args.cwd);
		if (!store) {
			console.error("No session to resume. Start a new session first.");
			process.exit(1);
		}
		const turnCount = (await store.turns()).length;
		console.error(`[session] Resumed ${store.id} (${turnCount} turns)`);
		return store;
	}

	const existingSessions = willUseTui && pickSession ? await sessions.list(args.cwd) : [];
	const allSessions = willUseTui && pickSession && existingSessions.length === 0 ? await sessions.listAll() : [];
	const shouldPick = willUseTui && pickSession && (existingSessions.length > 0 || allSessions.length > 0);
	const pickedId = shouldPick ? await pickSession(args.cwd, sessions, preview) : undefined;
	if (pickedId) {
		const local = existingSessions.find((s) => s.id === pickedId);
		const store = local
			? await sessions.resume(args.cwd, pickedId)
			: await resumeAcrossCwds(sessions, pickedId, args.cwd);
		const turnCount = (await store.turns()).length;
		console.error(`[session] Resumed ${store.id} (${turnCount} turns)`);
		return store;
	}

	const store = await sessions.create(args.cwd);
	console.error(`[session] ${store.id}`);
	return store;
}

/**
 *
 */
async function resumeAcrossCwds(sessions: SessionStoreFactory, id: string, fallbackCwd: string): Promise<SessionStore> {
	const all = await sessions.listAll();
	const match = all.find((s) => s.id === id);
	if (match?.cwd) {
		try {
			return await sessions.resume(match.cwd, id);
		} catch {
			/* fall through */
		}
	}
	return sessions.resume(fallbackCwd, id);
}
