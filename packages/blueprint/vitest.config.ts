import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const resolve = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@dpopsuev\/alef-agent-core$/, replacement: resolve("../agent/src/index.ts") },
			{ find: /^@dpopsuev\/alef-ai$/, replacement: resolve("../ai/src/index.ts") },
		],
	},
	test: {
		include: ["test/**/*.test.ts"],
	},
});
