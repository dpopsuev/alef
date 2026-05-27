import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const resolve = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@dpopsuev\/alef-spine$/, replacement: resolve("../spine/src/index.ts") },
			{ find: /^@dpopsuev\/alef-corpus$/, replacement: resolve("../corpus/src/index.ts") },
			{ find: /^@dpopsuev\/alef-testkit$/, replacement: resolve("../testkit/src/index.ts") },
			{ find: /^@dpopsuev\/alef-organ-dialog$/, replacement: resolve("../organ-dialog/src/index.ts") },
			{ find: /^@dpopsuev\/alef-organ-fs$/, replacement: resolve("../organ-fs/src/index.ts") },
			{ find: /^@dpopsuev\/alef-organ-shell$/, replacement: resolve("../organ-shell/src/index.ts") },
			{ find: /^@dpopsuev\/alef-organ-llm$/, replacement: resolve("../organ-llm/src/index.ts") },
			{ find: /^@dpopsuev\/alef-organ-lector$/, replacement: resolve("../organ-lector/src/index.ts") },
			{ find: /^@dpopsuev\/alef-organ-web$/, replacement: resolve("../organ-web/src/index.ts") },
			{ find: /^@dpopsuev\/alef-agent-blueprint$/, replacement: resolve("../blueprint/src/index.ts") },
		],
	},
	test: {
		include: ["test/**/*.test.ts"],
		// Real-LLM scenarios are slow — give them room.
		testTimeout: 120_000,
		hookTimeout: 30_000,
		// Register OTel provider once before any test runs.
		setupFiles: ["./src/otel-setup.ts"],
		// Serial execution within each file. The globalSpanExporter is a
		// process-level singleton — concurrent tests in the same file would
		// corrupt each other's span data. Each file already runs in its own
		// fork (vitest default), so cross-file contamination is not an issue.
		sequence: { concurrent: false },
	},
});
