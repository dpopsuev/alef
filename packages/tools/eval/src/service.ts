import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import { createEvalAdapter } from "./adapter.js";

export const service: ServiceDescriptor = {
	name: "eval",
	restart: "temporary",
	shareable: false,

	create(opts: ServiceCreateOpts): Promise<ManagedService> {
		const adapter = createEvalAdapter({ cwd: opts.cwd, logger: opts.logger, replyEvent: "agent.reply" });

		return Promise.resolve({
			name: "eval",
			restart: "temporary",
			adapters: [adapter],
			tools: [...adapter.tools],

			start: () => Promise.resolve(),

			stop: () => Promise.resolve(),

			health: () => Promise.resolve(true),
		});
	},
};
