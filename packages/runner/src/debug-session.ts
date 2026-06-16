/**
 * alef debug session — inspect session JSONL for tool-call pairing issues.
 *
 * Mirrors djinn debug session: reads the session event log, groups motor/sense
 * events by correlationId, detects orphaned tool calls (motor with no matching
 * sense response), and reports the session summary.
 *
 * Usage:
 *   alef debug session              — inspect most recent session for current cwd
 *   alef debug session <id>         — inspect session by ID prefix
 *   alef debug session --list       — list sessions for current cwd
 */

import { readFile } from "node:fs/promises";

import type { StorageRecord } from "./session-store.js";
import { SessionStore } from "./session-store.js";

export async function runDebugSession(args: string[], cwd: string): Promise<void> {
	if (args.includes("--list") || args.includes("-l")) {
		await listSessions(cwd);
		return;
	}

	const idPrefix = args[0];
	await inspectSession(cwd, idPrefix);
}

async function listSessions(cwd: string): Promise<void> {
	const sessions = await SessionStore.list(cwd);
	if (sessions.length === 0) {
		console.log("No sessions for", cwd);
		return;
	}
	for (const s of sessions) {
		console.log(`${s.id}  ${s.mtime.toISOString().replace("T", " ").slice(0, 16)}  ${s.path}`);
	}
}

async function inspectSession(cwd: string, idPrefix?: string): Promise<void> {
	const sessions = await SessionStore.list(cwd);
	if (sessions.length === 0) {
		console.error("No sessions for", cwd);
		process.exit(1);
	}

	let target = sessions[0]; // most recent
	if (idPrefix) {
		const found = sessions.find((s) => s.id.startsWith(idPrefix));
		if (!found) {
			console.error(`No session matching '${idPrefix}'. Run 'alef debug session --list'.`);
			process.exit(1);
		}
		target = found;
	}

	const raw = await readFile(target.path, "utf-8").catch(() => "");
	const records: StorageRecord[] = raw
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line) as StorageRecord;
			} catch {
				return null;
			}
		})
		.filter((r): r is StorageRecord => r !== null);

	// Group motor events by correlationId — these are tool calls dispatched to organs.
	// Each motor event with a non-dialog type should get a matching sense response.
	const motorByCorr = new Map<string, StorageRecord[]>();
	const senseByCorr = new Map<string, StorageRecord[]>();
	let turns = 0;
	let errors = 0;

	for (const r of records) {
		const key = r.correlationId;
		if (r.bus === "motor") {
			if (r.type === "llm.response") {
				turns++;
				continue;
			}
			if (!motorByCorr.has(key)) motorByCorr.set(key, []);
			(motorByCorr.get(key) as StorageRecord[]).push(r);
		} else if (r.bus === "sense") {
			if ((r.payload as { isError?: boolean }).isError) errors++;
			if (r.type === "llm.input") continue;
			if (!senseByCorr.has(key)) senseByCorr.set(key, []);
			(senseByCorr.get(key) as StorageRecord[]).push(r);
		}
	}

	console.log(`Session: ${target.id}`);
	console.log(`Path:    ${target.path}`);
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
				issues.push(`orphaned motor/${m.type} (corr=${short}) — no sense response`);
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
