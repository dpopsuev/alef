/**
 * alef debug session — inspect session events for tool-call pairing issues.
 *
 * Usage:
 *   alef debug session              — inspect most recent session for current cwd
 *   alef debug session <id>         — inspect session by ID prefix
 *   alef debug session --list       — list sessions for current cwd
 */

import type { StorageRecord } from "@dpopsuev/alef-session/storage";
import type { SessionStoreFactory } from "@dpopsuev/alef-storage";

export async function runDebugSession(args: string[], cwd: string, sessions: SessionStoreFactory): Promise<void> {
	if (args.includes("--list") || args.includes("-l")) {
		await listSessions(cwd, sessions);
		return;
	}

	const idPrefix = args[0];
	await inspectSession(cwd, sessions, idPrefix);
}

async function listSessions(cwd: string, sessions: SessionStoreFactory): Promise<void> {
	const list = await sessions.list(cwd);
	if (list.length === 0) {
		console.log("No sessions for", cwd);
		return;
	}
	for (const s of list) {
		console.log(`${s.id}  ${s.mtime.toISOString().replace("T", " ").slice(0, 16)}`);
	}
}

async function inspectSession(cwd: string, sessions: SessionStoreFactory, idPrefix?: string): Promise<void> {
	const list = await sessions.list(cwd);
	if (list.length === 0) {
		console.error("No sessions for", cwd);
		process.exit(1);
	}

	let target = list[0];
	if (idPrefix) {
		const found = list.find((s) => s.id.startsWith(idPrefix));
		if (!found) {
			console.error(`No session matching '${idPrefix}'. Run 'alef debug session --list'.`);
			process.exit(1);
		}
		target = found;
	}

	const store = await sessions.resume(cwd, target.id);
	const records: StorageRecord[] = await store.events();

	const motorByCorr = new Map<string, StorageRecord[]>();
	const senseByCorr = new Map<string, StorageRecord[]>();
	let turns = 0;
	let errors = 0;

	for (const r of records) {
		const key = r.correlationId;
		if (r.bus === "command") {
			if (r.type === "llm.response") {
				turns++;
				continue;
			}
			if (!motorByCorr.has(key)) motorByCorr.set(key, []);
			motorByCorr.get(key)!.push(r);
		} else if (r.bus === "event") {
			if (r.payload.isError) errors++;
			if (r.type === "llm.input") continue;
			if (!senseByCorr.has(key)) senseByCorr.set(key, []);
			senseByCorr.get(key)!.push(r);
		}
	}

	console.log(`Session: ${target.id}`);
	console.log(`Events:  ${records.length}  Turns: ${turns}  Errors: ${errors}`);
	console.log();

	const issues: string[] = [];
	let paired = 0;
	let orphaned = 0;

	for (const [corrId, motorEvents] of motorByCorr) {
		const senseEvents = senseByCorr.get(corrId) ?? [];
		const short = corrId.slice(0, 8);

		for (const m of motorEvents) {
			const matched = senseEvents.find((s) => s.type === m.type);
			if (matched) {
				paired++;
				const elapsedMs = matched.timestamp - m.timestamp;
				console.log(`  ok ${short}  ${m.type}  ${elapsedMs}ms`);
			} else {
				orphaned++;
				issues.push(`orphaned command/${m.type} (corr=${short}) — no sense response`);
				console.log(`  -- ${short}  ${m.type}  NO SENSE RESPONSE`);
			}
		}
	}

	console.log();
	console.log(`Paired: ${paired}  Orphaned: ${orphaned}`);

	if (issues.length > 0) {
		console.log();
		console.log("Issues:");
		for (const issue of issues) console.log(`  • ${issue}`);
		process.exit(1);
	} else {
		console.log("Session is clean.");
	}
}
