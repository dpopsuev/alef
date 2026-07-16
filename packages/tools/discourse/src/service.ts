import { defineAdapterService } from "@dpopsuev/alef-foundry";
import { createDiscourseAdapter } from "./adapter.js";

export const service = defineAdapterService({
	name: "discourse",
	restart: "transient",
	shareable: true,
	createAdapter(opts) {
		return createDiscourseAdapter({
			sessionDir: opts.cwd,
			logger: opts.logger,
			actorAddress: opts.actorAddress,
			ignoredThread: opts.discussion ? { topic: opts.discussion.forumId, thread: opts.discussion.topicId } : undefined,
		});
	},
});
