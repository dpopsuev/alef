import { describe, expect, it } from "vitest";
import { AgentKernel } from "../src/agent-kernel.js";

describe("AgentKernel.buildCheckpointCallback", () => {
	it("returns undefined when getSession is undefined", () => {
		expect(AgentKernel.buildCheckpointCallback(undefined)).toBeUndefined();
	});

	it("returns a callback when getSession is provided", () => {
		const fn = AgentKernel.buildCheckpointCallback(() => undefined);
		expect(typeof fn).toBe("function");
	});

	it("callback is a no-op when getSession returns undefined", () => {
		const fn = AgentKernel.buildCheckpointCallback(() => undefined);
		expect(() => fn!([], "corr-1")).not.toThrow();
	});
});
