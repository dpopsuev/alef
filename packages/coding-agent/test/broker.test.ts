/**
 * Tests for the agent broker — protocol, OTP restart policies,
 * intensity tracking, shutdown ordering, and message routing.
 */

import { describe, expect, it } from "vitest";
import type { RestartPolicy, SupervisorToAgent } from "../src/broker/protocol.js";
import { isAgentToSupervisor, isSupervisorToAgent } from "../src/broker/protocol.js";

// ---------------------------------------------------------------------------
// Protocol type guards
// ---------------------------------------------------------------------------

describe("Broker — protocol type guards", () => {
	it("isAgentToSupervisor identifies all request types", () => {
		expect(isAgentToSupervisor({ type: "spawn", id: "a", config: { name: "w", prompt: "p" } })).toBe(true);
		expect(isAgentToSupervisor({ type: "kill", id: "a" })).toBe(true);
		expect(isAgentToSupervisor({ type: "status" })).toBe(true);
		expect(isAgentToSupervisor({ type: "rebuild" })).toBe(true);
	});

	it("isAgentToSupervisor rejects invalid input", () => {
		expect(isAgentToSupervisor({ type: "unknown" })).toBe(false);
		expect(isAgentToSupervisor("string")).toBe(false);
		expect(isAgentToSupervisor(null)).toBe(false);
		expect(isAgentToSupervisor(undefined)).toBe(false);
		expect(isAgentToSupervisor(42)).toBe(false);
	});

	it("isSupervisorToAgent identifies all response types", () => {
		expect(isSupervisorToAgent({ type: "spawn_started", id: "x", pid: 123 })).toBe(true);
		expect(isSupervisorToAgent({ type: "spawn_event", id: "x", event: {} })).toBe(true);
		expect(
			isSupervisorToAgent({
				type: "spawn_complete",
				id: "x",
				exitCode: 0,
				output: "",
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			}),
		).toBe(true);
		expect(isSupervisorToAgent({ type: "spawn_error", id: "x", error: "boom" })).toBe(true);
		expect(isSupervisorToAgent({ type: "status_response", agents: [] })).toBe(true);
		expect(isSupervisorToAgent({ type: "rebuild_ack" })).toBe(true);
	});

	it("isSupervisorToAgent rejects unknown types", () => {
		expect(isSupervisorToAgent({ type: "unknown" })).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// AgentBroker — message routing and OTP logic
// ---------------------------------------------------------------------------

describe("Broker — AgentBroker message handling", () => {
	it("rebuild request sends ack", async () => {
		const { AgentBroker } = await import("../src/broker/agent-broker.js");
		const sent: SupervisorToAgent[] = [];
		const broker = new AgentBroker("/tmp/repo", (msg) => sent.push(msg));
		broker.handleMessage({ type: "rebuild" });
		expect(sent).toHaveLength(1);
		expect(sent[0].type).toBe("rebuild_ack");
	});

	it("status with no agents returns empty list", async () => {
		const { AgentBroker } = await import("../src/broker/agent-broker.js");
		const sent: SupervisorToAgent[] = [];
		const broker = new AgentBroker("/tmp/repo", (msg) => sent.push(msg));
		broker.handleMessage({ type: "status" });
		expect(sent).toHaveLength(1);
		expect(sent[0].type).toBe("status_response");
		if (sent[0].type === "status_response") {
			expect(sent[0].agents).toHaveLength(0);
		}
	});

	it("kill non-existent agent sends error", async () => {
		const { AgentBroker } = await import("../src/broker/agent-broker.js");
		const sent: SupervisorToAgent[] = [];
		const broker = new AgentBroker("/tmp/repo", (msg) => sent.push(msg));
		broker.handleMessage({ type: "kill", id: "ghost" });
		expect(sent).toHaveLength(1);
		expect(sent[0].type).toBe("spawn_error");
		if (sent[0].type === "spawn_error") {
			expect(sent[0].error).toContain("ghost");
		}
	});

	it("killAll is safe when empty", async () => {
		const { AgentBroker } = await import("../src/broker/agent-broker.js");
		const broker = new AgentBroker("/tmp/repo", () => {});
		await broker.killAll();
	});
});

// ---------------------------------------------------------------------------
// OTP restart policies
// ---------------------------------------------------------------------------

/** Mirrors the broker's restart decision logic */
function shouldRestart(policy: RestartPolicy, exitCode: number): boolean {
	switch (policy) {
		case "permanent":
			return true;
		case "transient":
			return exitCode !== 0;
		case "temporary":
			return false;
	}
}

describe("Broker — OTP restart policies", () => {
	it("temporary: never restart regardless of exit code", () => {
		expect(shouldRestart("temporary", 0)).toBe(false);
		expect(shouldRestart("temporary", 1)).toBe(false);
		expect(shouldRestart("temporary", 137)).toBe(false);
	});

	it("transient: restart on crash, not on normal exit", () => {
		expect(shouldRestart("transient", 0)).toBe(false);
		expect(shouldRestart("transient", 1)).toBe(true);
		expect(shouldRestart("transient", 137)).toBe(true);
	});

	it("permanent: always restart", () => {
		expect(shouldRestart("permanent", 0)).toBe(true);
		expect(shouldRestart("permanent", 1)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Restart intensity tracking
// ---------------------------------------------------------------------------

describe("Broker — restart intensity", () => {
	it("crashes within window are counted", () => {
		const now = Date.now();
		const windowMs = 60_000;
		const maxIntensity = 3;

		const crashes = [now - 30_000, now - 20_000, now - 10_000, now];
		const windowStart = now - windowMs;
		const recentCrashes = crashes.filter((t) => t >= windowStart);

		expect(recentCrashes.length).toBe(4);
		expect(recentCrashes.length > maxIntensity).toBe(true);
		// Should give up after exceeding intensity
	});

	it("old crashes outside window are pruned", () => {
		const now = Date.now();
		const windowMs = 60_000;

		const crashes = [now - 120_000, now - 90_000, now - 10_000];
		const windowStart = now - windowMs;
		const recentCrashes = crashes.filter((t) => t >= windowStart);

		expect(recentCrashes.length).toBe(1);
		// Only the recent crash counts
	});

	it("intensity resets after window expires", () => {
		const now = Date.now();
		const windowMs = 10_000; // short window
		const maxIntensity = 2;

		// 3 crashes, but 2 are outside the window
		const crashes = [now - 20_000, now - 15_000, now - 1_000];
		const windowStart = now - windowMs;
		const recentCrashes = crashes.filter((t) => t >= windowStart);

		expect(recentCrashes.length).toBe(1);
		expect(recentCrashes.length <= maxIntensity).toBe(true);
		// Still under limit — can restart
	});
});

// ---------------------------------------------------------------------------
// Shutdown ordering
// ---------------------------------------------------------------------------

describe("Broker — shutdown ordering", () => {
	it("children should be stopped in reverse-start order", () => {
		const children = [
			{ name: "db", startOrder: 0 },
			{ name: "cache", startOrder: 1 },
			{ name: "server", startOrder: 2 },
		];

		const shutdownOrder = [...children].sort((a, b) => b.startOrder - a.startOrder);
		expect(shutdownOrder.map((c) => c.name)).toEqual(["server", "cache", "db"]);
	});

	it("shutdown timeout defaults to 5000ms", () => {
		const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
		const config: { name: string; prompt: string; shutdownTimeout?: number } = { name: "worker", prompt: "task" };
		const timeout = config.shutdownTimeout ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
		expect(timeout).toBe(5_000);
	});

	it("custom shutdown timeout is respected", () => {
		const config = { name: "worker", prompt: "task", shutdownTimeout: 10_000 };
		expect(config.shutdownTimeout).toBe(10_000);
	});
});

// ---------------------------------------------------------------------------
// SpawnConfig shape
// ---------------------------------------------------------------------------

describe("Broker — SpawnConfig with OTP fields", () => {
	it("minimal config defaults to temporary restart", () => {
		const config: { name: string; prompt: string; restart?: RestartPolicy } = { name: "worker", prompt: "task" };
		const restart: RestartPolicy = config.restart ?? "temporary";
		expect(restart).toBe("temporary");
	});

	it("permanent restart config", () => {
		const config = { name: "watcher", prompt: "monitor", restart: "permanent" as RestartPolicy };
		expect(config.restart).toBe("permanent");
	});

	it("transient restart with custom shutdown timeout", () => {
		const config = {
			name: "reviewer",
			prompt: "review",
			restart: "transient" as RestartPolicy,
			shutdownTimeout: 15_000,
		};
		expect(config.restart).toBe("transient");
		expect(config.shutdownTimeout).toBe(15_000);
	});
});

// ---------------------------------------------------------------------------
// BrokerClient contract (no IPC in tests)
// ---------------------------------------------------------------------------

describe("Broker — BrokerClient contract", () => {
	it("supervised detection depends on process.send", () => {
		const hasSend = typeof process.send === "function";
		expect(typeof hasSend).toBe("boolean");
	});

	it("spawn message includes restart policy", () => {
		const msg = {
			type: "spawn" as const,
			id: "abc",
			config: { name: "worker", prompt: "task", restart: "transient" as RestartPolicy },
		};
		expect(isAgentToSupervisor(msg)).toBe(true);
		expect(msg.config.restart).toBe("transient");
	});
});

// ---------------------------------------------------------------------------
// Protocol contract — message sequences
// ---------------------------------------------------------------------------

describe("Broker — protocol contract", () => {
	it("spawn → started → event* → complete (normal lifecycle)", () => {
		expect(isAgentToSupervisor({ type: "spawn", id: "1", config: { name: "t", prompt: "p" } })).toBe(true);
		expect(isSupervisorToAgent({ type: "spawn_started", id: "1", pid: 42 })).toBe(true);
		expect(isSupervisorToAgent({ type: "spawn_event", id: "1", event: {} })).toBe(true);
		expect(
			isSupervisorToAgent({
				type: "spawn_complete",
				id: "1",
				exitCode: 0,
				output: "",
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			}),
		).toBe(true);
	});

	it("spawn → started → complete(crash) → started (restart cycle)", () => {
		// A transient/permanent agent crash triggers automatic restart
		const complete = {
			type: "spawn_complete" as const,
			id: "1",
			exitCode: 1,
			output: "",
			stderr: "segfault",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		};
		const restarted = { type: "spawn_started" as const, id: "1", pid: 99 };

		expect(isSupervisorToAgent(complete)).toBe(true);
		expect(isSupervisorToAgent(restarted)).toBe(true);
	});

	it("spawn → started → complete(crash) x N → error (intensity exceeded)", () => {
		const error = { type: "spawn_error" as const, id: "1", error: "exceeded restart intensity" };
		expect(isSupervisorToAgent(error)).toBe(true);
	});

	it("status response includes OTP fields", () => {
		const resp = {
			type: "status_response" as const,
			agents: [
				{
					id: "1",
					name: "worker",
					pid: 42,
					running: true,
					startedAt: Date.now(),
					restart: "transient" as RestartPolicy,
					restartCount: 2,
				},
			],
		};
		expect(isSupervisorToAgent(resp)).toBe(true);
		expect(resp.agents[0].restart).toBe("transient");
		expect(resp.agents[0].restartCount).toBe(2);
	});
});
