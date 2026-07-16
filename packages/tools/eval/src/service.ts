import { defineAdapterService } from "@dpopsuev/alef-foundry";
import { createEvalAdapter } from "./adapter.js";

export const service = defineAdapterService({
	name: "eval",
	restart: "temporary",
	shareable: false,
	createAdapter(opts) {
		return createEvalAdapter({ cwd: opts.cwd, logger: opts.logger, replyEvent: "agent.reply" });
	},
});
