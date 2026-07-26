import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discourseConformanceSuite } from "@danypops/discourse/conformance";
import { InMemoryDiscourseSubscriptions } from "@danypops/discourse/memory-store";
import { DiscourseService } from "@danypops/discourse/service";
import { createClient } from "@libsql/client";
import { afterAll } from "vitest";
import { ensureDiscourseSchema } from "../src/ensure-schema.js";
import { SqliteCapabilityDiscourseStore } from "../src/sqlite-capability-store.js";

const clients: Array<ReturnType<typeof createClient>> = [];
const directories: string[] = [];
let identifier = 0;
let timestamp = 10_000;

afterAll(() => {
	for (const client of clients) client.close();
	for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

discourseConformanceSuite(async (options) => {
	const directory = mkdtempSync(join(tmpdir(), "discourse-conformance-"));
	directories.push(directory);
	const client = createClient({ url: `file:${join(directory, "store.db")}` });
	clients.push(client);
	await ensureDiscourseSchema(client);
	return {
		service: new DiscourseService({
			store: new SqliteCapabilityDiscourseStore(client, "acme", options?.eventRetention),
			subscriptions: new InMemoryDiscourseSubscriptions(),
			createId: () => `sqlite-post-${++identifier}`,
			now: () => ++timestamp,
		}),
	};
});
