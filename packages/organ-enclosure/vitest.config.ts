import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const spineSrc = fileURLToPath(new URL("../spine/src/index.ts", import.meta.url));

export default defineConfig({
	resolve: {
		alias: [{ find: /^@dpopsuev\/alef-spine$/, replacement: spineSrc }],
	},
	test: {
		include: ["test/**/*.test.ts"],
		env: {
			// Disable Ryuk cleanup daemon — not needed in dev, avoids Docker socket bind issues.
			TESTCONTAINERS_RYUK_DISABLED: "true",
		},
	},
});
