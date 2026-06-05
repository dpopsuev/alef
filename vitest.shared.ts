/**
 * Shared vitest config for all organ and library packages in the monorepo.
 *
 * Uses vite-tsconfig-paths to resolve @dpopsuev/alef-* imports to their
 * source TypeScript files via the paths declared in the root tsconfig.json.
 * That file is already maintained as the single source of truth for all
 * monorepo package locations — editors, TypeScript, and now vitest all
 * read from the same place.
 *
 * Usage in packages/organ-X/vitest.config.ts:
 *
 *   import { defineProject, mergeConfig } from "vitest/config";
 *   import sharedConfig from "../../vitest.shared.js";
 *   export default mergeConfig(sharedConfig, defineProject({ test: { name: "organ-shell" } }));
 *
 * New organ developers: add one entry to the root tsconfig.json paths when
 * creating a new package. No other config file needs updating.
 */

import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
	plugins: [tsconfigPaths({ root: "../../" })],
	test: {
		include: ["test/**/*.test.ts"],
	},
});
