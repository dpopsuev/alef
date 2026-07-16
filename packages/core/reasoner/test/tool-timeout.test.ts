import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import type { Bus } from "@dpopsuev/alef-kernel/bus";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@dpopsuev/alef-ai/faux";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { BusFixture, TurnDriver } from "../../testkit/src/index.js";
import { createAgentLoop } from "../src/index.js";
import { explicitToolTimeoutMs, resolveToolSupervisionPolicy } from "../src/tool-dispatch.js";

describe("explicitToolTimeoutMs", { tags: ["unit"] }, () => {
	it("reads timeoutMs and maxMs as milliseconds", () => {
		expect(explicitToolTimeoutMs({ timeoutMs: 1500 })).toBe(1500);
		expect(explicitToolTimeoutMs({ maxMs: 2000 })).toBe(2000);
	});

	it("reads timeout as seconds (shell.exec / nodesh)", () => {
		expect(explicitToolTimeoutMs({ timeout: 30 })).toBe(30_000);
		expect(explicitToolTimeoutMs({ timeout: 60 })).toBe(60_000);
	});

	it("prefers timeoutMs over timeout seconds", () => {
		expect(explicitToolTimeoutMs({ timeoutMs: 500, timeout: 30 })).toBe(500);
	});
});

describe("resolveToolSupervisionPolicy", { tags: ["unit"] }, () => {
	it("keeps shell timeout as adapter-owned runtime while supervision wakes earlier", () => {
		const policy = resolveToolSupervisionPolicy("shell.exec", { command: "tsc", timeout: 30 }, 300_000);
		expect(policy.allowInfiniteWait).toBe(true);
		expect(policy.expectedRuntimeMs).toBe(30_000);
		expect(policy.wakeAfterMs).toBeLessThan(policy.expectedRuntimeMs);
	});

	it("treats background-like calls as patient supervision instead of hard deadlines", () => {
		const policy = resolveToolSupervisionPolicy(
			"shell.exec",
			{ command: "npm run dev", block_until_ms: 0 },
			300_000,
		);
		expect(policy.allowInfiniteWait).toBe(true);
		expect(policy.suggestedActions).toEqual(["wait", "inspect", "cancel", "extend"]);
		expect(policy.wakeAfterMs).toBeGreaterThan(0);
	});
});

function waitUntil(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const timer = setInterval(() => {
			if (check()) {
				clearInterval(timer);
				resolve();
				return;
			}
			if (Date.now() - started >= timeoutMs) {
				clearInterval(timer);
				reject(new Error(`Timed out waiting for ${label}`));
			}
		}, 20);
	});
}

function makeMockToolAdapter(mode: "quiet" | "stalled" | "cancel") {
	const timers = new Set<ReturnType<typeof setTimeout>>();
	const states = new Map<string, { correlationId: string; cancelled: boolean; release: () => void }>();
	const tool = {
		name: "mock.run",
		description: "Mock long-running tool for supervision tests.",
		inputSchema: z.object({ scenario: z.string().optional() }),
	};
	const schedule = (fn: () => void, delayMs: number): void => {
		const timer = setTimeout(() => {
			timers.delete(timer);
			fn();
		}, delayMs);
		timers.add(timer);
	};
	const publish = (
		bus: Bus,
		correlationId: string,
		toolCallId: string,
		payload: Record<string, unknown>,
		isError = false,
		errorMessage?: string,
	): void => {
		bus.event.publish({
			type: "mock.run",
			correlationId,
			payload: { ...payload, toolCallId },
			isError,
			...(errorMessage ? { errorMessage } : {}),
		});
	};
	const adapter: Adapter = {
		name: "mock-supervision",
		description: "Mock supervision adapter.",
		labels: [],
		tools: [tool],
		subscriptions: { command: ["mock.run"], event: [], notification: ["tools.cancel-request"] },
		sources: [],
		mount(bus) {
			const offCommand = bus.command.subscribe("mock.run", (event) => {
				const toolCallId = String(event.payload.toolCallId ?? "");
				const correlationId = event.correlationId;
				const release = () => {
					publish(bus, correlationId, toolCallId, { content: "tool finished", isFinal: true });
				};
				states.set(toolCallId, { correlationId, cancelled: false, release });
				if (mode === "stalled") {
					schedule(() => {
						publish(bus, correlationId, toolCallId, { text: "booting...", isFinal: false });
					}, 20);
					schedule(() => {
						publish(bus, correlationId, toolCallId, {
							isFinal: false,
							classification: "cpu-idle",
							outputTail: "booting...",
							processAlive: true,
							cpuActive: false,
						});
					}, 60);
				}
			});
			const offCancel = bus.notification.subscribe("tools.cancel-request", (event) => {
				const callId = typeof event.payload.callId === "string" ? event.payload.callId : "";
				const state = states.get(callId);
				if (!state || state.cancelled) return;
				state.cancelled = true;
				if (mode === "cancel") {
					schedule(() => {
						publish(
							bus,
							state.correlationId,
							callId,
							{ content: "cancelled by adapter", isFinal: true },
							true,
							"cancelled by adapter",
						);
					}, 30);
				}
			});
			return () => {
				offCommand();
				offCancel();
				for (const timer of timers) clearTimeout(timer);
				timers.clear();
				states.clear();
			};
		},
	};
	return {
		adapter,
		releaseAll(): void {
			for (const state of states.values()) state.release();
		},
	};
}

describe("timeout supervision flows", { tags: ["unit"] }, () => {
	const fixtures: BusFixture[] = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.dispose();
	});

	it("wakes on a quiet long-running tool, the model chooses wait, and the final result succeeds", async () => {
		const faux = registerFauxProvider();
		const mock = makeMockToolAdapter("quiet");
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("mock_run", { scenario: "quiet" })]),
			() => {
				setTimeout(() => mock.releaseAll(), 50);
				return fauxAssistantMessage("wait");
			},
			fauxAssistantMessage("completed without timeout"),
		]);
		const f = new BusFixture();
		fixtures.push(f);
		const driver = new TurnDriver(f.bus, undefined, undefined, mock.adapter.tools);
		const wakeEvents: Array<Record<string, unknown>> = [];
		f.bus.asBus().notification.subscribe("llm.tool-wake", (event) => {
			wakeEvents.push(event.payload as Record<string, unknown>);
		});
		f.mount(createAgentLoop({ model: faux.getModel(), apiKey: "faux-key", timeoutMs: 2_000 }));
		f.mount(mock.adapter);

		const reply = await driver.send("run mock tool", "human", 5_000);

		expect(reply).toBe("completed without timeout");
		expect(faux.state.callCount).toBe(3);
		expect(wakeEvents).toEqual([
			expect.objectContaining({
				name: "mock.run",
				reason: "slow",
				availableActions: ["wait", "inspect", "cancel", "extend"],
			}),
		]);
	});

	it("emits a wake with the latest output snapshot after progress stops", async () => {
		const faux = registerFauxProvider();
		const mock = makeMockToolAdapter("stalled");
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("mock_run", { scenario: "stalled" })]),
			() => {
				setTimeout(() => mock.releaseAll(), 50);
				return fauxAssistantMessage("wait");
			},
			fauxAssistantMessage("stalled run recovered"),
		]);
		const f = new BusFixture();
		fixtures.push(f);
		const driver = new TurnDriver(f.bus, undefined, undefined, mock.adapter.tools);
		const wakeEvents: Array<Record<string, unknown>> = [];
		f.bus.asBus().notification.subscribe("llm.tool-wake", (event) => {
			wakeEvents.push(event.payload as Record<string, unknown>);
		});
		f.mount(createAgentLoop({ model: faux.getModel(), apiKey: "faux-key", timeoutMs: 800 }));
		f.mount(mock.adapter);

		const reply = await driver.send("run stalled mock tool", "human", 6_000);

		expect(reply).toBe("stalled run recovered");
		expect(wakeEvents).toEqual([
			expect.objectContaining({
				name: "mock.run",
				outputTail: expect.stringContaining("booting"),
			}),
		]);
	});

	it("publishes cancel-request first and falls back only if the adapter ignores it", async () => {
		const faux = registerFauxProvider();
		const mock = makeMockToolAdapter("cancel");
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("mock_run", { scenario: "cancel" })]),
			fauxAssistantMessage("cancel"),
			fauxAssistantMessage("cancelled cleanly"),
		]);
		const f = new BusFixture();
		fixtures.push(f);
		const driver = new TurnDriver(f.bus, undefined, undefined, mock.adapter.tools);
		const cancelRequests: string[] = [];
		f.bus.asBus().notification.subscribe("tools.cancel-request", (event) => {
			cancelRequests.push(String(event.payload.callId ?? ""));
		});
		f.mount(createAgentLoop({ model: faux.getModel(), apiKey: "faux-key", timeoutMs: 2_000 }));
		f.mount(mock.adapter);

		const replyPromise = driver.send("cancel the mock tool", "human", 5_000);
		await waitUntil(() => cancelRequests.length === 1, 3_000, "cancel request");
		const reply = await replyPromise;

		expect(reply).toBe("cancelled cleanly");
		expect(cancelRequests[0]).toBeTruthy();
	});
});
