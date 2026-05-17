import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const resolve = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@dpopsuev\/alef-spine$/, replacement: resolve("../spine/src/index.ts") },
		],
	},
	test: {
		include: ["test/**/*.test.ts"],
	},
});
