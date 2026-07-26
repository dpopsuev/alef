import { resolve } from "node:path";
import { defineProject, mergeConfig } from "vitest/config";
import sharedConfig from "../../vitest.shared.js";

export default mergeConfig(
	sharedConfig,
	defineProject({
		resolve: {
			// Exact-match only (^...$): a plain string key here would prefix-match
			// subpath imports too (e.g. @dpopsuev/alef-foundry/lifecycle), mangling
			// them into "<index.ts path>/lifecycle" instead of leaving them for
			// tsconfig-paths to resolve.
			alias: [
				{
					find: /^@dpopsuev\/alef-foundry$/,
					replacement: resolve(import.meta.dirname, "../core/foundry/src/index.ts"),
				},
			],
		},
		test: {
			name: "runner",
			testTimeout: 5_000,
			server: {
				deps: {
					inline: ["@dpopsuev/alef-foundry", "@dpopsuev/alef-tui"],
				},
			},
		},
	}),
);
