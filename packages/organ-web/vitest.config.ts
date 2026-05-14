import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const spineSrc = fileURLToPath(new URL("../spine/src/index.ts", import.meta.url));
const webSpiderSrc = fileURLToPath(new URL("../../../pi-mono/packages/web-spider/src/index.ts", import.meta.url));

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@dpopsuev\/alef-spine$/, replacement: spineSrc },
			{ find: /^@dpopsuev\/web-spider$/, replacement: webSpiderSrc },
		],
	},
	test: {
		include: ["test/**/*.test.ts"],
	},
});
