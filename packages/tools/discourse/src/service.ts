import { defineAdapterService } from "@dpopsuev/alef-foundry";
import { getDatabase } from "@dpopsuev/alef-storage/sqlite/database";
import { createDiscourseAdapter } from "./adapter.js";
import { openDiscourseBackend, openInMemoryDiscourseBackend } from "./open-backend.js";

export const service = defineAdapterService({
	name: "discourse",
	restart: "transient",
	shareable: true,
	dependsOn: ["storage"],
	async createAdapter(opts) {
		// The Board is the durable, workspace-scoped conversation space; falling back to the
		// process sessionId only keeps headless/no-discussion callers working, and still leaves
		// that data isolated to its own process rather than bleeding into an unrelated board.
		const boardId = opts.discussion?.forumId ?? opts.sessionId;
		const ignoredThread = opts.discussion
			? { topic: opts.discussion.forumId, thread: opts.discussion.topicId }
			: undefined;
		if (!boardId) {
			return createDiscourseAdapter({
				backend: openInMemoryDiscourseBackend({ logger: opts.logger }),
				logger: opts.logger,
				actorAddress: opts.actorAddress,
				ignoredThread,
			});
		}
		const client = await getDatabase();
		const backend = await openDiscourseBackend({
			client,
			boardId,
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
