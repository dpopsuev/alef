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
			{ find: /^@dpopsuev\/alef-organ-fs$/, replacement: resolve("../organ-fs/src/index.ts") },
			{ find: /^@dpopsuev\/alef-organ-shell$/, replacement: resolve("../organ-shell/src/index.ts") },
			{ find: /^@dpopsuev\/alef-organ-llm$/, replacement: resolve("../organ-llm/src/index.ts") },
		],
	},
	test: {
		include: ["test/**/*.test.ts"],
	},
});
