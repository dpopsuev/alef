import type { ServiceDescriptor, ManagedService, ServiceCreateOpts } from "@dpopsuev/alef-supervisor/lifecycle";
import { createCodeIntelAdapter } from "./adapter.js";
import { LocalCodeIntelBackend } from "./local-backend.js";

export const service: ServiceDescriptor = {
	name: "code-intel",
	restart: "permanent",
	shareable: true,

	create(opts: ServiceCreateOpts): Promise<ManagedService> {
		const backend = new LocalCodeIntelBackend({
			cwd: opts.cwd,
		});
		const adapter = createCodeIntelAdapter({ cwd: opts.cwd, backend, logger: opts.logger });

		return Promise.resolve({
			name: "code-intel",
			restart: "permanent",
			adapters: [adapter],
			tools: [...adapter.tools],

			async start() {
				await backend.warmUp();
			},

			async stop() {
				await backend.stopLsp();
			},

			health: () => Promise.resolve(true),
		});
	},
};
