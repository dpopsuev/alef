/**
 * Adapter history — per-adapter indexing of command events in SessionStore.
 *
 * Given/When/Then:
 *   Given command events with type "fs.read" and "shell.exec" are appended
 *   When adapterHistory("fs") is called
 *   Then only events whose type starts with "fs." are returned
 *   And adapterHistory("shell") returns only shell events
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionStore } from "@dpopsuev/alef-session/store";
import { InMemorySessionStore } from "@dpopsuev/alef-testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("JsonlSessionStore.adapterHistory(name)", { tags: ["unit"] }, () => {
	let cwd: string;
	let store: JsonlSessionStore;

	beforeEach(async () => {
		cwd = mkdtempSync(join(tmpdir(), "alef-adapter-history-"));
		store = await JsonlSessionStore.create(cwd);
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("returns fs events for adapterHistory('fs')", async () => {
		await store.append({
			bus: "command",
			type: "fs.read",
			correlationId: "c1",
			payload: { path: "/a.ts" },
			timestamp: 1,
		});
		await store.append({
			bus: "command",
			type: "fs.write",
			correlationId: "c2",
			payload: { path: "/b.ts" },
			timestamp: 2,
		});
		await store.append({
			bus: "command",
			type: "shell.exec",
			correlationId: "c3",
			payload: { command: "ls" },
			timestamp: 3,
		});

		const fsHistory = await store.adapterHistory("fs");
		expect(fsHistory).toHaveLength(2);
		expect(fsHistory.every((e) => e.type.startsWith("fs."))).toBe(true);
	});

	it("returns shell events for adapterHistory('shell')", async () => {
		await store.append({
			bus: "command",
			type: "shell.exec",
			correlationId: "c4",
			payload: { command: "npm test" },
			timestamp: 4,
		});
		await store.append({
			bus: "event",
			type: "shell.exec",
			correlationId: "c4",
			payload: { output: "ok" },
			timestamp: 5,
		});

		const shellHistory = await store.adapterHistory("shell");
		// Both command and sense events for shell.exec
		expect(shellHistory.length).toBeGreaterThanOrEqual(1);
		expect(shellHistory.every((e) => e.type.startsWith("shell."))).toBe(true);
	});

	it("returns empty array for unknown organ name", async () => {
		await store.append({ bus: "command", type: "fs.read", correlationId: "c5", payload: {}, timestamp: 5 });
		const history = await store.adapterHistory("nonexistent");
		expect(history).toHaveLength(0);
	});

	it("SessionStore interface includes adapterHistory", async () => {
		const memStore = new InMemorySessionStore();
		await memStore.append({
			bus: "command",
			type: "web.search",
			correlationId: "c6",
			payload: { query: "ona" },
			timestamp: 6,
		});
		const webHistory = await memStore.adapterHistory("web");
		expect(webHistory).toHaveLength(1);
		expect(webHistory[0]!.type).toBe("web.search");
	});
});
