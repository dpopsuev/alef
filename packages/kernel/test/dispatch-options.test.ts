import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AccessDecision, AccessPolicy } from "../src/access-policy.js";
import { createMapCache } from "../src/adapter-cache.js";
import { dispatchCommandAction } from "../src/adapter-dispatch.js";
import type { CommandMessage, EventMessage } from "../src/buses.js";
import { InProcessNerve } from "../src/in-process-nerve.js";

function makeNerve() {
	const nerve = new InProcessNerve();
	return { nerve, n: nerve.asBus() };
}

function waitEvent(nerve: InProcessNerve, type: string): Promise<EventMessage> {
	return new Promise((resolve) => {
		const off = nerve.asBus().event.subscribe(type, (e) => {
			off();
			resolve(e);
		});
	});
}

function createCommandMessage(type: string, correlationId: string): CommandMessage {
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
		const promise = waitEvent(nerve, "test.action");

		const command = createCommandMessage("test.action", "corr-1");

		// Dispatch with injected policy
		await dispatchCommandAction(command, action, n, cache, noopLogger, undefined, { policy: denyAllPolicy });

		const event = await promise;
		expect(event.isError).toBe(true);
		expect(event.errorMessage).toContain("test policy denies all");
	});

	it("allows no policy to be provided", async () => {
		const { nerve, n } = makeNerve();

		const action = {
			tool: { name: "test.nopolicy", description: "Test", inputSchema: z.object({}) },
			async *handle() {
				yield { result: "executed" };
			},
		};

		const cache = createMapCache();
		const promise = waitEvent(nerve, "test.nopolicy");

		const command = createCommandMessage("test.nopolicy", "corr-2");

		// Dispatch without any policy - should allow
		await dispatchCommandAction(command, action, n, cache, noopLogger, undefined);

		const event = await promise;
		expect(event.isError).toBe(false);
		expect(event.payload).toMatchObject({ result: "executed" });
	});

	it("explicit policy overrides no-policy default", async () => {
		const { nerve, n } = makeNerve();

		const denyPolicy: AccessPolicy = {
			check: (): AccessDecision => ({ action: "deny", reason: "explicitly denied" }),
		};

		const action = {
			tool: { name: "test.override", description: "Test", inputSchema: z.object({}) },
			async *handle() {
				yield { result: "executed" };
			},
		};

		const cache = createMapCache();
		const promise = waitEvent(nerve, "test.override");

		const command = createCommandMessage("test.override", "corr-3");

		// Explicit deny should work
		await dispatchCommandAction(command, action, n, cache, noopLogger, undefined, { policy: denyPolicy });

		const event = await promise;
		expect(event.isError).toBe(true);
		expect(event.errorMessage).toContain("explicitly denied");
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
		const promise = waitEvent(nerve, "test.escalate");

		const command = createCommandMessage("test.escalate", "corr-4");

		await dispatchCommandAction(command, action, n, cache, noopLogger, undefined, {
			policy: escalatePolicy,
			onEscalate: approveHandler,
		});

		expect(escalateCalled).toBe(true);
		const event = await promise;
		expect(event.isError).toBe(false);
		expect(event.payload).toMatchObject({ result: "approved" });
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
		const promise = waitEvent(nerve, "test.no-handler");

		const command = createCommandMessage("test.no-handler", "corr-5");

		await dispatchCommandAction(command, action, n, cache, noopLogger, undefined, { policy: escalatePolicy });

		const event = await promise;
		expect(event.isError).toBe(true);
		expect(event.errorMessage).toContain("needs approval");
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
		const promise = waitEvent(nerve, "test.mock");

		const command = createCommandMessage("test.mock", "corr-6");

		await dispatchCommandAction(command, action, n, cache, noopLogger, undefined, { policy: mockPolicy });

		const event = await promise;
		expect(event.isError).toBe(false);
		expect(event.payload).toMatchObject({ result: "mocked" });
	});
});
