import { defineProject, mergeConfig } from "vitest/config";
import sharedConfig from "../../../vitest.shared.js";

export default mergeConfig(
	sharedConfig,
	defineProject({
		test: {
			name: "organ-enclosure",
			env: {
				// Ryuk (testcontainers cleanup sidecar) fails in this environment.
				// Containers are cleaned up by the test themselves via space.destroy().
				TESTCONTAINERS_RYUK_DISABLED: "true",
			},
		},
	}),
);
