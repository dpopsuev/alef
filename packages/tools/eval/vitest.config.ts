import { defineProject, mergeConfig } from "vitest/config";
import sharedConfig from "../../../vitest.shared.js";

export default mergeConfig(sharedConfig, defineProject({ test: { name: "tool-eval", testTimeout: 15_000 } }));
