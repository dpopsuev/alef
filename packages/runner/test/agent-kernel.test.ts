import { describe, expect, it } from "vitest";
import { buildCheckpointCallback } from "../src/agent-kernel.js";

describe("buildCheckpointCallback", { tags: ["unit"] }, () => {
	it("returns undefined when getSession is undefined", () => {
		expect(buildCheckpointCallback(undefined)).toBeUndefined();
	});

	it("returns a callback when getSession is provided", () => {
		const fn = buildCheckpointCallback(() => undefined);
		expect(typeof fn).toBe("function");
	});

	it("callback is a no-op when getSession returns undefined", () => {
		const fn = buildCheckpointCallback(() => undefined);
		expect(() => fn!([], "corr-1")).not.toThrow();
	});
});
