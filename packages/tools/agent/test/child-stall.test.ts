import { describe, expect, it, vi } from "vitest";

vi.mock("@dpopsuev/alef-engine/remote", () => ({
	RemoteStrategy: class {
		constructor(private readonly opts: { onStall?: () => void }) {}
		async send() {
			this.opts.onStall?.();
			return "";
		}
	},
}));

import { handleAsk, type ChildLifecycleDeps } from "../src/child-lifecycle.js";

describe("handleAsk stall signal", { tags: ["unit"] }, () => {
	it("publishes agent.child.stalled on stall", async () => {
		const publishInnerSignal = vi.fn();
		const stop = vi.fn(async () => {});
		const kill = vi.fn();
		const deps: ChildLifecycleDeps = {
			cwd: "/tmp",
			replyEvent: "llm.response",
			readinessTimeoutMs: 1000,
			currentDepth: 0,
			maxDepth: 2,
			supervisor: {
				get: () =>
					({
						entry: {
							name: "child-a",
							endpoint: "http://127.0.0.1:9",
							process: { kill },
						},
					}) as never,
				stop,
				names: () => ["child-a"],
			} as never,
			strategies: new Map([["child-a", {}]]),
			publishInnerSignal,
			logger: { warn: vi.fn() },
		};

		await handleAsk(deps, {
			payload: { name: "child-a", prompt: "hello" },
			toolCallId: "call-1",
			correlationId: "corr-1",
		});

		expect(publishInnerSignal).toHaveBeenCalledWith(
			"agent.child.stalled",
			{ name: "child-a", callId: "call-1" },
			"corr-1",
		);
		expect(kill).toHaveBeenCalledWith("SIGTERM");
		expect(stop).toHaveBeenCalledWith("child-a");
	});
});
