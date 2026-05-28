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
		// Real-LLM scenarios are slow — multi-turn on Vertex needs up to 5 min.
		// Evaluation.scenarioTimeoutMs can override per-scenario.
		testTimeout: 360_000,
		hookTimeout: 30_000,
		// Register OTel provider once before any test runs.
		setupFiles: ["./src/otel-setup.ts"],
		// Spans are isolated per eval via traceId (see EvalHarness.collectSpansByTrace).
		// No need for sequence: { concurrent: false } — concurrent tests are safe.
	},
});
