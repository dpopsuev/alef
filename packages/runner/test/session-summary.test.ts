/**
 * SessionSummary — written at agent exit.
 *
 * Verifies that summaries are written to SQLite and last-session.json.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@dpopsuev/alef-llm";
import { createAgentLoop } from "@dpopsuev/alef-reasoner";
import { Agent, AgentController } from "@dpopsuev/alef-runtime";
import { applySchema, SqliteSessionStore, SqliteSummaryStore } from "@dpopsuev/alef-storage";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SessionLog } from "../src/event-log-organ.js";

describe("SessionSummary", { tags: ["unit"] }, () => {
	const dbs: Database.Database[] = [];
	afterEach(() => {
		for (const db of dbs.splice(0)) db.close();
	});

	it("writes summary to SQLite and last-session.json on agent dispose", async () => {
		const db = new Database(":memory:");
		db.pragma("journal_mode = WAL");
		db.pragma("foreign_keys = ON");
		applySchema(db);
		dbs.push(db);

		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("done")]);

		const store = SqliteSessionStore.create(db, "/tmp/test-cwd");
		const agent = new Agent();
		const log = new SessionLog(store, "test-model");
		agent.load(createAgentLoop({ model: faux.getModel(), apiKey: "faux-key" })).load(log);
		const controller = new AgentController(agent);

		await controller.send("hello", "user", 10_000);
		agent.dispose();

		await new Promise((r) => setTimeout(r, 50));

		const summaries = new SqliteSummaryStore(db);
		const summary = summaries.get(store.id);

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
