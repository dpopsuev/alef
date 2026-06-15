import { defineProject, mergeConfig } from "vitest/config";
import sharedConfig from "../../vitest.shared.js";

export default mergeConfig(
	sharedConfig,
	defineProject({
		test: {
			name: "llm",
			environment: "node",
			testTimeout: 30000,
		},
	}),
);
