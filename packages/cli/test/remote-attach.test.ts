import { Agent } from "@dpopsuev/alef-engine/agent";
import type { AgentEvent } from "@dpopsuev/alef-session/contracts";
import { createRemoteHarness } from "@dpopsuev/alef-testkit";
import { step } from "@dpopsuev/alef-testkit/script";
import { ScriptedReasoner } from "@dpopsuev/alef-testkit/scripted-reasoner";
import { afterEach, describe, expect, it } from "vitest";
import { type DaemonEntry, RemoteSession } from "../src/boot/remote.js";

function makeEntry(host: string, port: number): DaemonEntry {
	return { host, port, pid: process.pid, sessionId: "test", cwd: process.cwd(), startedAt: Date.now() };
}

function waitForEvent(remote: RemoteSession, type: string, timeoutMs = 5_000): Promise<AgentEvent> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			unsub();
			reject(new Error(`Timed out waiting for ${type}`));
		}, timeoutMs);
		const unsub = remote.subscribe((e) => {
			if (e.type === type) {
				clearTimeout(timer);
				unsub();
				resolve(e);
			}
		});
	});
}

describe("RemoteSession ↔ RouterAdapter", { tags: ["integration"] }, () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const fn of cleanups.splice(0)) fn();
	});

	it("remote session receives turn-complete via SSE after server-side send", async () => {
		const agent = new Agent();
		agent.load(new ScriptedReasoner([step.reply("hello from daemon")]));

		const harness = await createRemoteHarness({ agent });
		cleanups.push(() => harness.dispose());

		const remote = new RemoteSession(makeEntry(harness.host, harness.port));
		cleanups.push(() => remote.dispose());
		await remote.ready();
		await new Promise((r) => setTimeout(r, 150));

		const done = waitForEvent(remote, "turn-complete");
		await harness.controller.send("ping", "user", 10_000);

		const event = await done;
		expect(event.type).toBe("turn-complete");
		expect((event as Extract<AgentEvent, { type: "turn-complete" }>).reply).toContain("hello from daemon");
	}, 10_000);

	it("remote session can send messages via POST /message", async () => {
		const agent = new Agent();
		agent.load(new ScriptedReasoner([step.reply("pong")]));

		const harness = await createRemoteHarness({ agent });
		cleanups.push(() => harness.dispose());

		const remote = new RemoteSession(makeEntry(harness.host, harness.port));
		cleanups.push(() => remote.dispose());
		await remote.ready();
		await new Promise((r) => setTimeout(r, 150));

		const done = waitForEvent(remote, "turn-complete");
		remote.receive("ping");

		const event = await done;
		expect(event.type).toBe("turn-complete");
		expect((event as Extract<AgentEvent, { type: "turn-complete" }>).reply).toContain("pong");
	}, 10_000);

	it("GET /state returns model and context window", async () => {
		const agent = new Agent();
		agent.load(new ScriptedReasoner([step.reply("ok")]));

		const harness = await createRemoteHarness({ agent });
		cleanups.push(() => harness.dispose());

		const remote = new RemoteSession(makeEntry(harness.host, harness.port));
		cleanups.push(() => remote.dispose());
		await remote.ready();

		expect(remote.getModel()!).toBe("test-model");
		expect(remote.state.contextWindow).toBe(128_000);
	}, 10_000);
});
