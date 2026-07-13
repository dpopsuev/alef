/**
 * Session lifecycle — create, close, restart, resume, and switch.
 *
 * Covers the boot loadSession paths and durable JsonlSessionStore behaviour
 * across process-like open/close cycles (drop handle → reopen).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageRecord } from "@dpopsuev/alef-session/storage";
import { JsonlSessionStore } from "@dpopsuev/alef-session/store";
import type { SessionStoreFactory } from "@dpopsuev/alef-storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSession } from "../src/boot/load.js";

const tempDirs: string[] = [];

function tmpCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "alef-sess-life-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function jsonlFactory(): SessionStoreFactory {
	return {
		create: (cwd) => JsonlSessionStore.create(cwd),
		resume: (cwd, id) => JsonlSessionStore.resume(cwd, id),
		resumeLatest: (cwd) => JsonlSessionStore.resumeLatest(cwd),
		list: (cwd) => JsonlSessionStore.list(cwd),
		listAll: () => JsonlSessionStore.listAll(),
		prune: (cwd) => JsonlSessionStore.prune(cwd),
	};
}

function turn(user: string, assistant: string, correlationId: string): StorageRecord[] {
	const now = Date.now();
	return [
		{
			bus: "event",
			type: "llm.input",
			correlationId,
			payload: { text: user, sender: "human" },
			timestamp: now,
		},
		{
			bus: "command",
			type: "llm.response",
			correlationId,
			payload: {
				text: assistant,
				conversationHistory: [
					{ role: "user", content: user },
					{ role: "assistant", content: assistant },
				],
			},
			timestamp: now + 1,
		},
	];
}

function mockExit(): ReturnType<typeof vi.spyOn> {
	return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		throw new Error(`process.exit(${code ?? 0})`);
	}) as never);
}

describe("session lifecycle — create / close / restart", { tags: ["unit"] }, () => {
	it("create → write → drop handle → resume preserves turns and accepts new events", async () => {
		const cwd = tmpCwd();
		const first = await JsonlSessionStore.create(cwd);
		const sessionId = first.id;
		for (const record of turn("hello", "hi there", "c-1")) {
			await first.append(record);
		}
		expect(await first.turns()).toHaveLength(1);
		// Close: drop the live handle (process exit analogue).
		const firstId = first.id;

		const second = await JsonlSessionStore.create(cwd);
		expect(second.id).not.toBe(firstId);
		for (const record of turn("brand new", "fresh session", "c-new")) {
			await second.append(record);
		}

		const resumed = await JsonlSessionStore.resume(cwd, sessionId);
		expect(resumed.id).toBe(sessionId);
		expect(await resumed.turns()).toHaveLength(1);
		for (const record of turn("continue", "picked up", "c-2")) {
			await resumed.append(record);
		}
		expect(await resumed.turns()).toHaveLength(2);

		const listed = await JsonlSessionStore.list(cwd);
		expect(listed.map((s) => s.id).sort()).toEqual([firstId, second.id].sort());
	});

	it("loadSession creates a new session when not resuming and not picking", async () => {
		const cwd = tmpCwd();
		const store = await loadSession({ cwd, resume: undefined, listSessions: false }, jsonlFactory(), false);
		expect(store.id).toMatch(/^[0-9a-f]{8}$/);
		expect(await store.events()).toHaveLength(0);
	});

	it("loadSession resume=last reopens the previous session after a new process start", async () => {
		const cwd = tmpCwd();
		const factory = jsonlFactory();
		const prior = await factory.create(cwd);
		for (const record of turn("prior turn", "prior reply", "c-1")) {
			await prior.append(record);
		}

		const resumed = await loadSession({ cwd, resume: "last", listSessions: false }, factory, false);
		expect(resumed.id).toBe(prior.id);
		expect(await resumed.turns()).toHaveLength(1);
	});

	it("loadSession resume=<id> reopens a specific closed session", async () => {
		const cwd = tmpCwd();
		const factory = jsonlFactory();
		const older = await factory.create(cwd);
		for (const record of turn("old", "old reply", "c-old")) {
			await older.append(record);
		}
		const newer = await factory.create(cwd);
		for (const record of turn("new", "new reply", "c-new")) {
			await newer.append(record);
		}

		const resumed = await loadSession({ cwd, resume: older.id, listSessions: false }, factory, false);
		expect(resumed.id).toBe(older.id);
		expect(await resumed.turns()).toHaveLength(1);
		const events = await resumed.events();
		expect(events.some((e) => e.payload.text === "old")).toBe(true);
	});
});

describe("session lifecycle — switch between sessions", { tags: ["unit"] }, () => {
	it("resume of an older session updates latest so resumeLatest follows the switch", async () => {
		const cwd = tmpCwd();
		const sessionA = await JsonlSessionStore.create(cwd);
		for (const record of turn("in A", "reply A", "a-1")) {
			await sessionA.append(record);
		}
		const sessionB = await JsonlSessionStore.create(cwd);
		for (const record of turn("in B", "reply B", "b-1")) {
			await sessionB.append(record);
		}

		expect((await JsonlSessionStore.resumeLatest(cwd))?.id).toBe(sessionB.id);

		const switched = await JsonlSessionStore.resume(cwd, sessionA.id);
		expect(switched.id).toBe(sessionA.id);
		expect((await JsonlSessionStore.resumeLatest(cwd))?.id).toBe(sessionA.id);

		for (const record of turn("back in A", "still A", "a-2")) {
			await switched.append(record);
		}
		expect(await switched.turns()).toHaveLength(2);

		const stillB = await JsonlSessionStore.resume(cwd, sessionB.id);
		expect(await stillB.turns()).toHaveLength(1);
		expect((await stillB.events()).some((e) => e.payload.text === "in B")).toBe(true);
	});

	it("TUI picker selecting an existing session resumes it instead of creating", async () => {
		const cwd = tmpCwd();
		const factory = jsonlFactory();
		const existing = await factory.create(cwd);
		for (const record of turn("picker target", "ok", "p-1")) {
			await existing.append(record);
		}
		await factory.create(cwd);

		const pickSession = vi.fn(async () => existing.id);
		const loaded = await loadSession({ cwd, resume: undefined, listSessions: false }, factory, true, pickSession);

		expect(pickSession).toHaveBeenCalledOnce();
		expect(loaded.id).toBe(existing.id);
		expect(await loaded.turns()).toHaveLength(1);
	});

	it("TUI picker choosing new session creates a fresh store while keeping prior sessions", async () => {
		const cwd = tmpCwd();
		const factory = jsonlFactory();
		const prior = await factory.create(cwd);
		for (const record of turn("keep me", "kept", "k-1")) {
			await prior.append(record);
		}

		const pickSession = vi.fn(async () => undefined);
		const loaded = await loadSession({ cwd, resume: undefined, listSessions: false }, factory, true, pickSession);

		expect(pickSession).toHaveBeenCalledOnce();
		expect(loaded.id).not.toBe(prior.id);
		expect(await loaded.events()).toHaveLength(0);

		const listed = await factory.list(cwd);
		expect(listed).toHaveLength(2);
		const revived = await factory.resume(cwd, prior.id);
		expect(await revived.turns()).toHaveLength(1);
	});

	it("non-TUI boot with existing sessions skips picker and always creates new", async () => {
		const cwd = tmpCwd();
		const factory = jsonlFactory();
		const prior = await factory.create(cwd);

		const pickSession = vi.fn(async () => prior.id);
		const loaded = await loadSession({ cwd, resume: undefined, listSessions: false }, factory, false, pickSession);

		expect(pickSession).not.toHaveBeenCalled();
		expect(loaded.id).not.toBe(prior.id);
	});
});

describe("session lifecycle — loadSession edge paths", { tags: ["unit"] }, () => {
	it("resume=last with no sessions exits 1", async () => {
		const cwd = tmpCwd();
		const exit = mockExit();
		vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(loadSession({ cwd, resume: "last", listSessions: false }, jsonlFactory(), false)).rejects.toThrow(
			/process\.exit\(1\)/,
		);
		expect(exit).toHaveBeenCalledWith(1);
	});

	it("listSessions prints ids then exits 0", async () => {
		const cwd = tmpCwd();
		const factory = jsonlFactory();
		const a = await factory.create(cwd);
		const b = await factory.create(cwd);
		const exit = mockExit();
		const lines: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		});

		await expect(loadSession({ cwd, resume: undefined, listSessions: true }, factory, false)).rejects.toThrow(
			/process\.exit\(0\)/,
		);
		expect(exit).toHaveBeenCalledWith(0);
		expect(lines.some((line) => line.includes(a.id))).toBe(true);
		expect(lines.some((line) => line.includes(b.id))).toBe(true);
	});
});
