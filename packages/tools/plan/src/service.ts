import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import { createPlanAdapter } from "./adapter.js";

export const service: ServiceDescriptor = {
	name: "plan",
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
		const adapter = createPlanAdapter({ cwd: opts.cwd, logger: opts.logger, actorAddress });

		return Promise.resolve({
			name: "plan",
			restart: "transient",
			adapters: [adapter],
			tools: [...adapter.tools],

			start: () => Promise.resolve(),

			async stop() {
				await adapter.close?.();
			},

			health: () => Promise.resolve(true),
		});
	},
};
