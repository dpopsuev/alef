import { defineAdapterService } from "@dpopsuev/alef-foundry";
import { createCodeIntelAdapter } from "./adapter.js";
import { LocalCodeIntelBackend } from "./local-backend.js";

const backends = new WeakMap<object, LocalCodeIntelBackend>();

export const service = defineAdapterService({
	name: "code-intel",
	restart: "permanent",
	shareable: true,
	createAdapter(opts) {
		const backend = new LocalCodeIntelBackend({
			cwd: opts.cwd,
		});
		const adapter = createCodeIntelAdapter({ cwd: opts.cwd, backend, logger: opts.logger });
		backends.set(adapter, backend);
		return adapter;
	},
	async start({ adapter }) {
		await backends.get(adapter)?.warmUp();
	},
	async stop({ adapter }) {
		const backend = backends.get(adapter);
		if (backend) {
			backends.delete(adapter);
			await backend.stopLsp();
			return;
		}
		await adapter.close?.();
	},
});
