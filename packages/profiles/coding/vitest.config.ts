import { defineProject, mergeConfig } from "vitest/config";
import sharedConfig from "../../../vitest.shared.js";

export default mergeConfig(
	sharedConfig,
	defineProject({
		test: {
			name: "alef-coding-agent",
			testTimeout: 360_000,
			hookTimeout: 30_000,
			setupFiles: ["../../packages/eval/src/otel-setup.ts"],
		},
	}),
);
