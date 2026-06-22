import type { Args } from "./args.js";
import { pickSession } from "./session-picker.js";
import { JsonlSessionStore } from "./session-store.js";

export async function loadSession(args: Args, willUseTui: boolean): Promise<JsonlSessionStore> {
	const pruned = await JsonlSessionStore.prune(args.cwd);
	if (pruned > 0) console.error(`[session] Pruned ${pruned} old session(s)`);
	if (args.listSessions) {
		const sessions = await JsonlSessionStore.list(args.cwd);
		if (sessions.length === 0) {
			console.log("No sessions for", args.cwd);
		} else {
			for (const session of sessions) {
				console.log(
					`${session.id}  ${session.mtime.toISOString().replace("T", " ").slice(0, 16)}  ${session.path}`,
				);
			}
		}
		process.exit(0);
	}

	if (args.resume) {
		const resumeId = args.resume === "last" ? undefined : args.resume;
		const store = resumeId
			? await JsonlSessionStore.resume(args.cwd, resumeId)
			: await JsonlSessionStore.resumeLatest(args.cwd);
		if (!store) {
			console.error("No session to resume. Start a new session first.");
			process.exit(1);
		}
		const turnCount = (await store.turns()).length;
		console.error(`[session] Resumed ${store.id} (${turnCount} turns)`);
		return store;
	}

	const existingSessions = willUseTui ? await JsonlSessionStore.list(args.cwd) : [];
	const pickedId = existingSessions.length > 0 ? await pickSession(existingSessions) : undefined;
	if (pickedId) {
		const store = await JsonlSessionStore.resume(args.cwd, pickedId);
		const turnCount = (await store.turns()).length;
		console.error(`[session] Resumed ${store.id} (${turnCount} turns)`);
		return store;
	}

	const store = await JsonlSessionStore.create(args.cwd);
	console.error(`[session] ${store.id}`);
	return store;
}
