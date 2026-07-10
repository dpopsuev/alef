import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import { createDiscourseAdapter } from "./adapter.js";

export const service: ServiceDescriptor = {
	name: "discourse",
	restart: "transient",
	shareable: false,

	dependsOn: ["session"],

	create(opts: ServiceCreateOpts): Promise<ManagedService> {
		let actorAddress = opts.actorAddress;
		if (!actorAddress) {
			const sessionSvc = opts.supervisor?.get("session");
			if (sessionSvc && "agentAddress" in sessionSvc) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by 'agentAddress' in check
					actorAddress = String((sessionSvc as Record<string, unknown>).agentAddress);
			}
		}
		const adapter = createDiscourseAdapter({ sessionDir: opts.cwd, logger: opts.logger, actorAddress });

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
