import { defineProject, mergeConfig } from "vitest/config";
import sharedConfig from "../../../vitest.shared.js";

export default mergeConfig(
	sharedConfig,
	defineProject({
		test: {
			name: "eval",
			// Real-LLM scenarios are slow — multi-turn on Vertex needs up to 5 min.
			testTimeout: 360_000,
			hookTimeout: 30_000,
			// Register OTel provider once before any test runs.
			setupFiles: ["./src/otel-setup.ts"],
		},
	}),
);
