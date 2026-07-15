/**
 * Production-readiness: cause walk from path/type against a fixture SQLite DB.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase } from "@dpopsuev/alef-storage/sqlite/database";
import { afterEach, describe, expect, it } from "vitest";
import { parseCauseFlags, resolveSpanIdFromEffect, walkCauseChain } from "../src/debug/cause-walk.js";

describe("cause walk production readiness", { tags: ["unit"] }, () => {
	let tempDir: string | undefined;

	afterEach(() => {
		closeDatabase();
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("resolves effect by --path/--type and walks to ROOT", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "alef-cause-"));
		const db = await getDatabase(join(tempDir, "alef.db"));

		const toolCallId = "call_fixture_1";
		const correlationId = "corr-fixture-1";
		const childSpan = "1111111111111111";
		const parentSpan = "2222222222222222";
		const rootSpan = "3333333333333333";
		const now = Date.now();

		await db.execute({
			sql: `INSERT INTO sessions (id, cwd_hash, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
			args: ["sess1", "hash", tempDir, now, now],
		});

		await db.execute({
			sql: `INSERT INTO events (session_id, bus, type, correlation_id, payload, timestamp)
				VALUES (?, ?, ?, ?, ?, ?)`,
			args: [
				"sess1",
				"event",
				"fs.write",
				correlationId,
				JSON.stringify({ toolCallId, path: "/tmp/fixture-out.ts", content: "x" }),
				now,
			],
		});

		await db.batch(
			[
				{
					sql: `INSERT INTO spans (span_id, trace_id, parent_span_id, name, kind, start_time, end_time, status, attributes, events, session_id)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					args: [
						childSpan,
						"t".repeat(32),
						parentSpan,
						"alef.command/fs.write",
						1,
						now,
						now + 5,
						0,
						JSON.stringify({ "alef.tool.call.id": toolCallId, "alef.correlation.id": correlationId }),
						"[]",
						"sess1",
					],
				},
				{
					sql: `INSERT INTO spans (span_id, trace_id, parent_span_id, name, kind, start_time, end_time, status, attributes, events, session_id)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					args: [
						parentSpan,
						"t".repeat(32),
						rootSpan,
						"chat claude",
						1,
						now - 10,
						now + 10,
						0,
						JSON.stringify({ "gen_ai.request.model": "claude-sonnet" }),
						"[]",
						"sess1",
					],
				},
				{
					sql: `INSERT INTO spans (span_id, trace_id, parent_span_id, name, kind, start_time, end_time, status, attributes, events, session_id)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					args: [rootSpan, "t".repeat(32), null, "alef.session", 1, now - 20, now + 20, 0, "{}", "[]", "sess1"],
				},
			],
			"write",
		);

		const flags = parseCauseFlags(["--path", "/tmp/fixture-out.ts", "--type", "fs.write"]);
		const spanId = await resolveSpanIdFromEffect(db, flags);
		expect(spanId).toBe(childSpan);

		const chain = await walkCauseChain(db, spanId!);
		expect(chain.map((s) => s.name)).toEqual(["alef.command/fs.write", "chat claude", "alef.session"]);
		expect(chain[chain.length - 1]!.name).toBe("alef.session");
	});
});
