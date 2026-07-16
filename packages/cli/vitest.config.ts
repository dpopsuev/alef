import { resolve } from "node:path";
import { defineProject, mergeConfig } from "vitest/config";
import sharedConfig from "../../vitest.shared.js";

export default mergeConfig(
	sharedConfig,
	defineProject({
		resolve: {
			alias: {
				"@dpopsuev/alef-foundry": resolve(import.meta.dirname, "../core/foundry/src/index.ts"),
			},
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
