/**
 * Vitest type augmentation — makes AlefTestTag available as autocomplete
 * in all test files. Include this file in tsconfig.json to activate.
 */

import "vitest";

declare module "vitest" {
	interface TestTags {
		tags: "unit" | "compliance" | "integration" | "e2e" | "real-llm" | "canary" | "benchmark";
	}
}
