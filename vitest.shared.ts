/**
 * Shared vitest config for all adapter and library packages in the monorepo.
 *
 * Uses vite-tsconfig-paths to resolve @dpopsuev/alef-* imports to their
 * source TypeScript files via the paths declared in the root tsconfig.json.
 * That file is the single source of truth for all monorepo package locations.
 *
 * Root vitest.config.ts discovers all packages via test.projects.
 * Each package has its own vitest.config.ts for per-package overrides:
 *
 *   import { defineProject, mergeConfig } from "vitest/config";
 *   import sharedConfig from "../../vitest.shared.js";
 *   export default mergeConfig(sharedConfig, defineProject({ test: { name: "adapter-shell" } }));
 *
 * New packages: add a vitest.config.ts + an entry to root tsconfig.json paths.
 *
 * ## Test Tags
 *
 * Every test carries exactly one category tag. Filter with:
 *   vitest --tags-filter="unit"
 *   vitest --tags-filter="real-llm"
 *   vitest --tags-filter="!real-llm"          # everything except real-llm
 *   vitest --tags-filter="unit or compliance"
 *   vitest --tags-filter="canary"             # just the health-check canary
 */

import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

const DEFAULT_INCLUDE = ["test/**/*.test.ts"];

export const TAGS = {
	UNIT: "unit",
	COMPLIANCE: "compliance",
	INTEGRATION: "integration",
	E2E: "e2e",
	REAL_LLM: "real-llm",
	CANARY: "canary",
	BENCHMARK: "benchmark",
} as const;

export type AlefTestTag = (typeof TAGS)[keyof typeof TAGS];

// vitest.shared.ts lives at the monorepo root — import.meta.dirname IS the root
const MONOREPO_ROOT = import.meta.dirname;

export default defineConfig({
	plugins: [tsconfigPaths({ root: MONOREPO_ROOT })],
	resolve: {
		conditions: ["source"],
		// vite-tsconfig-paths applies to files within the vite project root
		// (the package directory). For cross-package imports in transitive deps
		// (e.g. organ-llm importing @dpopsuev/alef-llm), tsconfig paths are NOT
		// applied, causing module duplication that breaks shared singletons.
		// resolve.alias applies globally and fixes this.
		alias: {
			"@dpopsuev/alef-llm": resolve(MONOREPO_ROOT, "packages/core/llm/src/index.ts"),
		},
	},
	test: {
		include: DEFAULT_INCLUDE,
		// Tag definitions — options here apply to every test carrying that tag.
		// strictTags: true would reject undefined tags; left off until all files are migrated.
		tags: [
			{ name: TAGS.UNIT, description: "Fast, isolated, no network, no real LLM." },
			{ name: TAGS.COMPLIANCE, description: "adapterComplianceSuite — adapter framework contract." },
			{ name: TAGS.INTEGRATION, description: "Multi-component, scripted LLM or real services." },
			{ name: TAGS.E2E, description: "Full stack, scripted replies, no real LLM required." },
			{
				name: TAGS.REAL_LLM,
				description: "Requires ANTHROPIC_API_KEY or ANTHROPIC_VERTEX_PROJECT_ID.",
				timeout: 90_000,
				retry: 1,
			},
			{
				name: TAGS.CANARY,
				description: "Minimal full-stack health check. Fails fast on pipeline regression.",
				timeout: 60_000,
				retry: 0,
			},
			{
				name: TAGS.BENCHMARK,
				description: "Performance and throughput measurements.",
				timeout: 300_000,
			},
		],
	},
});
