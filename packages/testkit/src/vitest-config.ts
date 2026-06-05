/**
 * @dpopsuev/alef-testkit/vitest-config — shared vitest configuration factory.
 *
 * Provides two named exports so internal and external organ developers use
 * identical 4-line vitest.config.ts files regardless of repo context:
 *
 *   import { defineProject, mergeConfig } from "vitest/config";
 *   import { monorepoConfig } from "@dpopsuev/alef-testkit/vitest-config";
 *   export default mergeConfig(
 *     monorepoConfig(new URL("../../", import.meta.url).pathname),
 *     defineProject({ test: { name: "organ-shell" } }),
 *   );
 *
 * External developers in their own repo use standaloneConfig() instead —
 * same 4-line pattern, no monorepo-specific path needed.
 */

import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

const DEFAULT_INCLUDE = ["test/**/*.test.ts"];

/**
 * Config for packages inside the alef monorepo.
 * Uses vite-tsconfig-paths so @dpopsuev/alef-* resolves to src/ via the
 * root tsconfig.json paths — no alias arrays needed.
 *
 * @param monorepoRoot Absolute path to the monorepo root (where tsconfig.json lives).
 *   Typically: new URL("../../", import.meta.url).pathname
 */
export function monorepoConfig(monorepoRoot: string) {
	return defineConfig({
		plugins: [tsconfigPaths({ root: monorepoRoot })],
		test: { include: DEFAULT_INCLUDE },
	});
}

/**
 * Config for external repos that consume published @dpopsuev/alef-* packages.
 * Uses resolve.conditions so the "source" export condition is tried first
 * (resolves to src/ when available), then falls back to "import" (dist/).
 * No plugin or tsconfig.json required.
 */
export function standaloneConfig() {
	return defineConfig({
		resolve: { conditions: ["source", "import", "default"] },
		test: { include: DEFAULT_INCLUDE },
	});
}
