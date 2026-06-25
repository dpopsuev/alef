import type { SessionStore } from "@dpopsuev/alef-session";
import type { SessionStoreFactory } from "@dpopsuev/alef-storage";

export interface SessionPreviewProvider {
	getSessionName?(id: string): Promise<string | undefined>;
	getSessionPreview?(id: string, maxLines: number): Promise<string[]>;
}

export type SessionPicker = (
	sessions: Array<{ id: string; path: string; mtime: Date }>,
	preview?: SessionPreviewProvider,
) => Promise<string | undefined>;

export interface LoadSessionArgs {
	cwd: string;
	resume: string | undefined;
	listSessions: boolean;
}

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
				console.log(`${session.id}  ${session.mtime.toISOString().replace("T", " ").slice(0, 16)}`);
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
	const pickedId =
		existingSessions.length > 0 && pickSession ? await pickSession(existingSessions, preview) : undefined;
	if (pickedId) {
		const store = await sessions.resume(args.cwd, pickedId);
		const turnCount = (await store.turns()).length;
		console.error(`[session] Resumed ${store.id} (${turnCount} turns)`);
		return store;
	}

	const store = await sessions.create(args.cwd);
	console.error(`[session] ${store.id}`);
	return store;
}
