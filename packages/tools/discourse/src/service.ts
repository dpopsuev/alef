import { defineAdapterService } from "@dpopsuev/alef-foundry";
import { getDatabase } from "@dpopsuev/alef-storage/sqlite/database";
import { createDiscourseAdapter } from "./adapter.js";
import { InMemoryDiscourseStore } from "./memory-store.js";
import { openDiscourseBackend } from "./open-backend.js";

export const service = defineAdapterService({
	name: "discourse",
	restart: "transient",
	shareable: true,
	dependsOn: ["storage"],
	async createAdapter(opts) {
		const sessionId = opts.sessionId ?? opts.discussion?.topicId;
		const ignoredThread = opts.discussion
			? { topic: opts.discussion.forumId, thread: opts.discussion.topicId }
			: undefined;
		if (!sessionId) {
			return createDiscourseAdapter({
				backend: new InMemoryDiscourseStore(),
				logger: opts.logger,
				actorAddress: opts.actorAddress,
				ignoredThread,
			});
		}
		const client = await getDatabase();
		const backend = await openDiscourseBackend({
			client,
			sessionId,
			logger: opts.logger,
		});
		return createDiscourseAdapter({
			backend,
			logger: opts.logger,
			actorAddress: opts.actorAddress,
			ignoredThread,
		});
	},
});
