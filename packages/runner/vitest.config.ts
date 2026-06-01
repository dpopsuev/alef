import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const resolve = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@dpopsuev\/alef-agent-blueprint$/, replacement: resolve("../blueprint/src/index.ts") },
			{ find: /^@dpopsuev\/alef-agent-core$/, replacement: resolve("../agent/src/index.ts") },
			{ find: /^@dpopsuev\/alef-corpus$/, replacement: resolve("../corpus/src/index.ts") },
			{ find: /^@dpopsuev\/alef-spine$/, replacement: resolve("../spine/src/index.ts") },
			{ find: /^@dpopsuev\/alef-organ-dialog$/, replacement: resolve("../organ-dialog/src/index.ts") },
			{ find: /^@dpopsuev\/alef-organ-router$/, replacement: resolve("../organ-router/src/index.ts") },
			{ find: /^@dpopsuev\/alef-organ-fs$/, replacement: resolve("../organ-fs/src/index.ts") },
			{ find: /^@dpopsuev\/alef-organ-lector$/, replacement: resolve("../organ-lector/src/index.ts") },
			{ find: /^@dpopsuev\/alef-tui$/, replacement: resolve("../tui/src/index.ts") },
			{ find: /^@dpopsuev\/alef-organ-nodesh$/, replacement: resolve("../organ-nodesh/src/index.ts") },
			// VirtualTerminal is imported by path (../../tui/test/virtual-terminal.js)
			// @xterm/headless needs to resolve from node_modules
			{ find: /^@dpopsuev\/alef-tui$/, replacement: resolve("../tui/src/index.ts") },
			{ find: /^@dpopsuev\/alef-organ-orchestration$/, replacement: resolve("../organ-orchestration/src/index.ts") },
			{ find: /^@dpopsuev\/alef-organ-delegate$/, replacement: resolve("../organ-delegate/src/index.ts") },
			{ find: /^@dpopsuev\/alef-organ-eval$/, replacement: resolve("../organ-eval/src/index.ts") },
			{ find: /^@dpopsuev\/alef-organ-shell$/, replacement: resolve("../organ-shell/src/index.ts") },
			{ find: /^@dpopsuev\/alef-organ-llm$/, replacement: resolve("../organ-llm/src/index.ts") },
			{ find: /^@dpopsuev\/alef-testkit$/, replacement: resolve("../testkit/src/index.ts") },
			{ find: /^@dpopsuev\/alef-testkit\/bdd$/, replacement: resolve("../testkit/src/bdd.ts") },
			{ find: /^@dpopsuev\/alef-organ-reactor$/, replacement: resolve("../organ-reactor/src/index.ts") },
		],
	},
	test: {
		include: ["test/**/*.test.ts"],
		testTimeout: 15_000,
	},
});
