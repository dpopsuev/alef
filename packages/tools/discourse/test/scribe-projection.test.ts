import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryDiscourseSubscriptions } from "@dpopsuev/discourse-capability/memory-store";
import type { ProjectionStatus } from "@dpopsuev/discourse-capability/types";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapabilityDiscourseBackend } from "../src/capability-backend.js";
import { ensureDiscourseSchema } from "../src/ensure-schema.js";
import { ScribeDiscourseProjection } from "../src/scribe-projection.js";
import { SqliteCapabilityDiscourseStore } from "../src/sqlite-capability-store.js";

const directories: string[] = [];
const clients: Array<ReturnType<typeof createClient>> = [];
afterEach(() => {
	for (const client of clients.splice(0)) client.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Scribe outbox projection", () => {
	it("keeps a failed record pending and catches up through the durable checkpoint", async () => {
		const directory = mkdtempSync(join(tmpdir(), "discourse-projection-"));
		directories.push(directory);
		const client = createClient({ url: `file:${join(directory, "store.db")}` });
		clients.push(client);
		await ensureDiscourseSchema(client);
		let available = false;
		let successfulMessages = 0;
		const call = vi.fn(async (action: string) => {
			if (!available) throw new Error("unavailable");
			if (action === "get") throw new Error("missing");
			if (action === "message_add") successfulMessages += 1;
			return "ok";
		});
		const statuses: ProjectionStatus[] = [];
		const store = new SqliteCapabilityDiscourseStore(client, "session-1");
		const backend = new CapabilityDiscourseBackend({
			store,
			subscriptions: new InMemoryDiscourseSubscriptions(),
			projections: [new ScribeDiscourseProjection(call, "mesh")],
			observeProjection: (status) => statuses.push(status),
		});

		await backend.append("qa", "nesting", "alice", "first", { operationId: "first" });
		expect(statuses.at(-1)).toMatchObject({ state: "failed", checkpoint: 0, pending: 1 });
		available = true;
		await backend.append("qa", "nesting", "bob", "second", { operationId: "second" });
		expect(statuses.at(-1)).toMatchObject({ state: "current", pending: 0 });
		expect(await store.projectionPending("scribe-mesh")).toBe(0);
		expect(successfulMessages).toBe(2);
	});
});
