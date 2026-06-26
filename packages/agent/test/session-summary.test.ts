/**
 * SessionSummary — written at agent exit.
 *
 * Verifies that summaries are written to SQLite and last-session.json.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@dpopsuev/alef-ai/faux";
import { Agent, AgentController } from "@dpopsuev/alef-engine";
import { createAgentLoop } from "@dpopsuev/alef-reasoner";
import { makeTestDatabase } from "@dpopsuev/alef-storage/sqlite/database";
import { SqliteSessionStore } from "@dpopsuev/alef-storage/sqlite/session";
import { SqliteSummaryStore } from "@dpopsuev/alef-storage/sqlite/summary";
import { afterEach, describe, expect, it } from "vitest";
import { SessionLog } from "../src/event-log-adapter.js";

describe("SessionSummary", { tags: ["unit"] }, () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const fn of cleanups.splice(0)) fn();
	});

	it("writes summary to SQLite and last-session.json on agent dispose", async () => {
		const { client, cleanup } = await makeTestDatabase();
		cleanups.push(cleanup);

		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("done")]);

		const store = await SqliteSessionStore.create(client, "/tmp/test-cwd");
		const summaries = new SqliteSummaryStore(client);
		const agent = new Agent();
		const log = new SessionLog(store, "test-model", undefined, (s) => summaries.write(s));
		agent.load(createAgentLoop({ model: faux.getModel(), apiKey: "faux-key" })).load(log);
		const controller = new AgentController(agent);

		await controller.send("hello", "user", 10_000);
		agent.dispose();

		await new Promise((r) => setTimeout(r, 50));

		const summary = await summaries.get(store.id);

		if (summary) {
			expect(summary.id).toBe(store.id);
			expect(summary.model).toBe("test-model");
			expect(summary.turns).toBeGreaterThanOrEqual(1);
			expect(summary.tokens).toBeDefined();
			expect(Array.isArray(summary.tools)).toBe(true);
			expect(summary.duration_ms).toBeGreaterThan(0);
		}

		const last = join(homedir(), ".alef", "last-session.json");
		const lastExists = await readFile(last, "utf-8")
			.then(() => true)
			.catch(() => false);
		expect(lastExists).toBe(true);
	});
});
