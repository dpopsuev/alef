import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AccessDecision, AccessPolicy } from "../src/access-policy.js";
import type { MotorEvent, SenseEvent } from "../src/buses.js";
import { InProcessNerve } from "../src/in-process-nerve.js";
import { createMapCache } from "../src/organ-cache.js";
import { dispatchMotorAction, setDispatchPolicy } from "../src/organ-dispatch.js";

function makeNerve() {
	const nerve = new InProcessNerve();
	return { nerve, n: nerve.asNerve() };
}

function waitSense(nerve: InProcessNerve, type: string): Promise<SenseEvent> {
	return new Promise((resolve) => {
		const off = nerve.asNerve().sense.subscribe(type, (e) => {
			off();
			resolve(e);
		});
	});
}

function createMotorEvent(type: string, correlationId: string): MotorEvent {
	return {
		type,
		payload: {},
		correlationId,
		timestamp: Date.now(),
		elapsed: 0,
	};
}

const noopLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	child: () => noopLogger,
};

describe("DispatchOptions - Dependency Injection", { tags: ["unit"] }, () => {
	it("allows policy injection per-call without global state", async () => {
		const { nerve, n } = makeNerve();

		const denyAllPolicy: AccessPolicy = {
			check: (): AccessDecision => ({ action: "deny", reason: "test policy denies all" }),
		};

		const action = {
			tool: { name: "test.action", description: "Test", inputSchema: z.object({}) },
			async *handle() {
				yield { result: "executed" };
			},
		};

		const cache = createMapCache();
		const promise = waitSense(nerve, "test.action");

		const motor = createMotorEvent("test.action", "corr-1");

		// Dispatch with injected policy
		await dispatchMotorAction(motor, action, n, cache, noopLogger, undefined, { policy: denyAllPolicy });

		const sense = await promise;
		expect(sense.isError).toBe(true);
		expect(sense.errorMessage).toContain("test policy denies all");
	});

	it("uses global policy as fallback when no options provided", async () => {
		const { nerve, n } = makeNerve();

		const denyAllPolicy: AccessPolicy = {
			check: (): AccessDecision => ({ action: "deny", reason: "global policy denies" }),
		};

		// Set global policy
		setDispatchPolicy(denyAllPolicy);

		const action = {
			tool: { name: "test.global", description: "Test", inputSchema: z.object({}) },
			async *handle() {
				yield { result: "executed" };
			},
		};

		const cache = createMapCache();
		const promise = waitSense(nerve, "test.global");

		const motor = createMotorEvent("test.global", "corr-2");

		// Dispatch without options - should use global
		await dispatchMotorAction(motor, action, n, cache, noopLogger, undefined);

		const sense = await promise;
		expect(sense.isError).toBe(true);
		expect(sense.errorMessage).toContain("global policy denies");

		// Clean up global state
		setDispatchPolicy(undefined);
	});

	it("explicit options override global policy", async () => {
		const { nerve, n } = makeNerve();

		const denyPolicy: AccessPolicy = {
			check: (): AccessDecision => ({ action: "deny", reason: "global denies" }),
		};

		const allowPolicy: AccessPolicy = {
			check: (): AccessDecision => ({ action: "allow" }),
		};

		// Set global deny policy
		setDispatchPolicy(denyPolicy);

		const action = {
			tool: { name: "test.override", description: "Test", inputSchema: z.object({}) },
			async *handle() {
				yield { result: "executed" };
			},
		};

		const cache = createMapCache();
		const promise = waitSense(nerve, "test.override");

		const motor = createMotorEvent("test.override", "corr-3");

		// Override with allow policy
		await dispatchMotorAction(motor, action, n, cache, noopLogger, undefined, { policy: allowPolicy });

		const sense = await promise;
		expect(sense.isError).toBe(false);
		expect(sense.payload).toMatchObject({ result: "executed" });

		// Clean up global state
		setDispatchPolicy(undefined);
	});

	it("handles escalation with injected handler", async () => {
		const { nerve, n } = makeNerve();

		const escalatePolicy: AccessPolicy = {
			check: (): AccessDecision => ({ action: "escalate", reason: "needs approval" }),
		};

		let escalateCalled = false;
		const approveHandler = async () => {
			escalateCalled = true;
			return true;
		};

		const action = {
			tool: { name: "test.escalate", description: "Test", inputSchema: z.object({}) },
			async *handle() {
				yield { result: "approved" };
			},
		};

		const cache = createMapCache();
		const promise = waitSense(nerve, "test.escalate");

		const motor = createMotorEvent("test.escalate", "corr-4");

		await dispatchMotorAction(motor, action, n, cache, noopLogger, undefined, {
			policy: escalatePolicy,
			onEscalate: approveHandler,
		});

		expect(escalateCalled).toBe(true);
		const sense = await promise;
		expect(sense.isError).toBe(false);
		expect(sense.payload).toMatchObject({ result: "approved" });
	});

	it("denies escalation when no handler provided", async () => {
		const { nerve, n } = makeNerve();

		const escalatePolicy: AccessPolicy = {
			check: (): AccessDecision => ({ action: "escalate", reason: "needs approval" }),
		};

		const action = {
			tool: { name: "test.no-handler", description: "Test", inputSchema: z.object({}) },
			async *handle() {
				yield { result: "should not execute" };
			},
		};

		const cache = createMapCache();
		const promise = waitSense(nerve, "test.no-handler");

		const motor = createMotorEvent("test.no-handler", "corr-5");

		await dispatchMotorAction(motor, action, n, cache, noopLogger, undefined, { policy: escalatePolicy });

		const sense = await promise;
		expect(sense.isError).toBe(true);
		expect(sense.errorMessage).toContain("needs approval");
	});

	it("allows mocking policy in tests without affecting global state", async () => {
		const { nerve, n } = makeNerve();

		const mockPolicy: AccessPolicy = {
			check: (toolName): AccessDecision => {
				if (toolName === "test.mock") {
					return { action: "allow" };
				}
				return { action: "deny", reason: "not test.mock" };
			},
		};

		const action = {
			tool: { name: "test.mock", description: "Test", inputSchema: z.object({}) },
			async *handle() {
				yield { result: "mocked" };
			},
		};

		const cache = createMapCache();
		const promise = waitSense(nerve, "test.mock");

		const motor = createMotorEvent("test.mock", "corr-6");

		await dispatchMotorAction(motor, action, n, cache, noopLogger, undefined, { policy: mockPolicy });

		const sense = await promise;
		expect(sense.isError).toBe(false);
		expect(sense.payload).toMatchObject({ result: "mocked" });
	});
});
