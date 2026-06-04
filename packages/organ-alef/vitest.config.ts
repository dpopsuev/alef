import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const r = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@dpopsuev\/alef-spine$/, replacement: r("../spine/src/index.ts") },
			{ find: /^@dpopsuev\/alef-testkit$/, replacement: r("../testkit/src/index.ts") },
		],
	},
	test: {
		include: ["test/**/*.test.ts"],
	},
});
