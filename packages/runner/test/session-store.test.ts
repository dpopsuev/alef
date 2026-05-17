import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "../src/session-store.js";

const tempDirs: string[] = [];
function tmpCwd(): string {
	const d = mkdtempSync(join(tmpdir(), "alef-session-"));
	tempDirs.push(d);
	return d;
}

afterEach(() => {
	for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("SessionStore.create", () => {
	it("creates a new session with a short ID", async () => {
		const store = await SessionStore.create(tmpCwd());
		expect(store.id).toMatch(/^[0-9a-f]{8}$/);
	});

	it("starts with empty messages", async () => {
		const store = await SessionStore.create(tmpCwd());
		expect(await store.messages()).toHaveLength(0);
	});
});

describe("SessionStore.append + messages", () => {
	it("round-trips user and assistant messages", async () => {
		const cwd = tmpCwd();
		const store = await SessionStore.create(cwd);
		await store.append({ role: "user", content: "hello", timestamp: 1000 });
		await store.append({ role: "assistant", content: "hi there", timestamp: 2000 });

		const msgs = await store.messages();
		expect(msgs).toHaveLength(2);
		expect(msgs[0]).toMatchObject({ role: "user", content: "hello" });
		expect(msgs[1]).toMatchObject({ role: "assistant", content: "hi there" });
	});

	it("persists across store re-opens", async () => {
		const cwd = tmpCwd();
		const store = await SessionStore.create(cwd);
		await store.append({ role: "user", content: "persistent", timestamp: 1000 });

		const resumed = await SessionStore.resume(cwd, store.id);
		const msgs = await resumed.messages();
		expect(msgs[0].content).toBe("persistent");
	});
});

describe("SessionStore.resume", () => {
	it("resumes a known session", async () => {
		const cwd = tmpCwd();
		const store = await SessionStore.create(cwd);
		await store.append({ role: "user", content: "hello", timestamp: 1000 });

		const resumed = await SessionStore.resume(cwd, store.id);
		expect(resumed.id).toBe(store.id);
		expect(await resumed.messages()).toHaveLength(1);
	});

	it("throws for unknown session ID", async () => {
		await expect(SessionStore.resume(tmpCwd(), "deadbeef")).rejects.toThrow(/not found/);
	});
});

describe("SessionStore.resumeLatest", () => {
	it("returns null when no sessions exist", async () => {
		expect(await SessionStore.resumeLatest(tmpCwd())).toBeNull();
	});

	it("returns the most recently created session", async () => {
		const cwd = tmpCwd();
		const s1 = await SessionStore.create(cwd);
		const s2 = await SessionStore.create(cwd);

		const latest = await SessionStore.resumeLatest(cwd);
		expect(latest?.id).toBe(s2.id);
		// s1 still exists
		const s1msgs = await s1.messages();
		expect(s1msgs).toHaveLength(0);
	});
});

describe("SessionStore.list", () => {
	it("returns empty list when no sessions", async () => {
		expect(await SessionStore.list(tmpCwd())).toHaveLength(0);
	});

	it("lists all sessions for a cwd", async () => {
		const cwd = tmpCwd();
		await SessionStore.create(cwd);
		await SessionStore.create(cwd);
		await SessionStore.create(cwd);

		const sessions = await SessionStore.list(cwd);
		expect(sessions).toHaveLength(3);
	});

	it("does not list sessions from a different cwd", async () => {
		const cwd1 = tmpCwd();
		const cwd2 = tmpCwd();
		await SessionStore.create(cwd1);

		expect(await SessionStore.list(cwd2)).toHaveLength(0);
	});
});
