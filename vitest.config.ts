/**
 * Root Vitest config — discovers all packages via test.projects.
 *
 * Replaces check-test.mjs. Run with:
 *   npx vitest run                          # all tests
 *   npx vitest run --tags-filter="unit"     # unit tests only
 *   npx vitest run --project=kernel         # single package
 *
 * Each package keeps its own vitest.config.ts for per-package overrides
 * (timeout, name). Shared settings live in vitest.shared.ts.
 */

import { defineConfig, mergeConfig } from "vitest/config";
import sharedConfig from "./vitest.shared.js";

export default mergeConfig(
	sharedConfig,
	defineConfig({
		test: {
			projects: ["packages/*/vitest.config.ts", "packages/*/*/vitest.config.ts"],
		},
	}),
);
