import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const spineSrc = fileURLToPath(new URL("../spine/src/index.ts", import.meta.url));
const corpusSrc = fileURLToPath(new URL("../corpus/src/index.ts", import.meta.url));
const textMessageSrc = fileURLToPath(new URL("../organ-text-message/src/index.ts", import.meta.url));

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@dpopsuev\/alef-spine$/, replacement: spineSrc },
			{ find: /^@dpopsuev\/alef-corpus$/, replacement: corpusSrc },
			{ find: /^@dpopsuev\/alef-organ-text-message$/, replacement: textMessageSrc },
		],
	},
	test: {
		include: ["test/**/*.test.ts"],
	},
});
