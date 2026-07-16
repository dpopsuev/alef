import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import { createDiscourseAdapter } from "./adapter.js";

export const service: ServiceDescriptor = {
	name: "discourse",
	restart: "transient",
	shareable: true,

	create(opts: ServiceCreateOpts): Promise<ManagedService> {
		const adapter = createDiscourseAdapter({
			sessionDir: opts.cwd,
			logger: opts.logger,
			actorAddress: opts.actorAddress,
			ignoredThread: opts.discussion ? { topic: opts.discussion.forumId, thread: opts.discussion.topicId } : undefined,
		});

		return Promise.resolve({
			name: "discourse",
			restart: "transient",
			adapters: [adapter],
			tools: [...adapter.tools],

			start: () => Promise.resolve(),

			stop: () => Promise.resolve(),

			health: () => Promise.resolve(true),
		});
	},
};
