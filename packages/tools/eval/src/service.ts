import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import { createEvalAdapter } from "./adapter.js";

export const service: ServiceDescriptor = {
	name: "eval",
	restart: "temporary",
	shareable: false,

	async create(opts: ServiceCreateOpts): Promise<ManagedService> {
		const adapter = createEvalAdapter({ cwd: opts.cwd, logger: opts.logger, replyEvent: "agent.reply" });

		return {
			name: "eval",
			restart: "temporary",
			adapters: [adapter],
			tools: [...adapter.tools],

			async start() {},

			async stop() {},

			async health() {
				return true;
			},
		};
	},
};
