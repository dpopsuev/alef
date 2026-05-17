import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const r = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@dpopsuev\/alef-spine$/, replacement: r("../spine/src/index.ts") },
			{ find: /^@dpopsuev\/alef-corpus$/, replacement: r("../corpus/src/index.ts") },
			{ find: /^@dpopsuev\/alef-organ-dialog$/, replacement: r("../organ-dialog/src/index.ts") },
			{ find: /^@dpopsuev\/alef-organ-fs$/, replacement: r("../organ-fs/src/index.ts") },
			{ find: /^@dpopsuev\/alef-organ-shell$/, replacement: r("../organ-shell/src/index.ts") },
			{ find: /^@dpopsuev\/alef-agent-blueprint$/, replacement: r("../blueprint/src/index.ts") },
			{ find: /^@dpopsuev\/alef-agent-core$/, replacement: r("../agent/src/index.ts") },
			{ find: /^@dpopsuev\/alef-organ-lector$/, replacement: r("../organ-lector/src/index.ts") },
		],
	},
	test: {
		include: ["test/**/*.test.ts"],
	},
});
