import type { Args } from "./args.js";
import { pickSession } from "./session-picker.js";
import { SessionStore } from "./session-store.js";

export async function loadSession(args: Args, willUseTui: boolean): Promise<SessionStore> {
	if (args.listSessions) {
		const sessions = await SessionStore.list(args.cwd);
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
			? await SessionStore.resume(args.cwd, resumeId)
			: await SessionStore.resumeLatest(args.cwd);
		if (!store) {
			console.error("No session to resume. Start a new session first.");
			process.exit(1);
		}
		const turnCount = (await store.turns()).length;
		console.error(`[session] Resumed ${store.id} (${turnCount} turns)`);
		return store;
	}

	const existingSessions = willUseTui ? await SessionStore.list(args.cwd) : [];
	const pickedId = existingSessions.length > 0 ? await pickSession(existingSessions) : undefined;
	if (pickedId) {
		const store = await SessionStore.resume(args.cwd, pickedId);
		const turnCount = (await store.turns()).length;
		console.error(`[session] Resumed ${store.id} (${turnCount} turns)`);
		return store;
	}

	const store = await SessionStore.create(args.cwd);
	console.error(`[session] ${store.id}`);
	return store;
}
