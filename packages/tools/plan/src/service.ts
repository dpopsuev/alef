import { defineAdapterService } from "@dpopsuev/alef-foundry";
import { createPlanAdapter } from "./adapter.js";

export const service = defineAdapterService({
	name: "plan",
	restart: "transient",
	shareable: false,
	dependsOn: ["session"],
	createAdapter(opts) {
		let actorAddress = opts.actorAddress;
		if (!actorAddress) {
			const sessionSvc = opts.supervisor?.get("session");
			if (sessionSvc && "agentAddress" in sessionSvc) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by 'agentAddress' in check
					actorAddress = String((sessionSvc as Record<string, unknown>).agentAddress);
			}
		}
		return createPlanAdapter({ cwd: opts.cwd, logger: opts.logger, actorAddress });
	},
});
