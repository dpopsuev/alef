import type { ExecutionStrategy } from "@dpopsuev/alef-spine";
import { organComplianceSuite } from "@dpopsuev/alef-testkit";
import { createDelegateOrgan } from "../src/organ.js";

// Stub strategy — stays within organ-delegate's own dep graph.
// Calls onChunk so the AsyncQueue relays isFinal:false sense events,
// satisfying the streaming contract without importing runner internals.
const slowStrategy: ExecutionStrategy = {
	async send(_text, _sender, _timeoutMs, onChunk) {
		await new Promise((r) => setTimeout(r, 80));
		onChunk?.("packages: ");
		await new Promise((r) => setTimeout(r, 40));
		onChunk?.("spine, corpus, runner");
		return "packages: spine, corpus, runner";
	},
};

organComplianceSuite(() => createDelegateOrgan({ strategies: { explore: slowStrategy } }), {
	streaming: {
		"agent.run": {
			validPayload: { text: "list the packages", profile: "explore" },
			thresholdMs: 100,
		},
	},
});
