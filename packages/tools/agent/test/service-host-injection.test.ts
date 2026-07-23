/**
 * createAgentAdapter's child-tracking runtime must use an injected platform
 * service host when one is provided, instead of always creating its own
 * private, disconnected Foundry runtime.
 *
 * Without this, every agent-delegation adapter instance spawns children into
 * a throwaway Supervisor invisible to the process's real platform Foundry
 * (the one hosting storage/session/tui/agent-delegation) — foundry.names()
 * at the platform level never shows spawned children.
 */

import { describe, expect, it, vi } from "vitest";

const { createFoundryRuntimeMock } = vi.hoisted(() => ({
	createFoundryRuntimeMock: vi.fn(() => ({
		get: vi.fn(),
		names: vi.fn(() => []),
		ensure: vi.fn(),
		stopService: vi.fn(),
	})),
}));

vi.mock("@dpopsuev/alef-foundry", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@dpopsuev/alef-foundry")>();
	return { ...actual, createFoundryRuntime: createFoundryRuntimeMock };
});

import { createAgentAdapter } from "../src/adapter.js";
import { service } from "../src/service.js";

describe("createAgentAdapter service host injection", { tags: ["unit"] }, () => {
	it("uses an injected serviceHost instead of creating a private Foundry runtime", () => {
		createFoundryRuntimeMock.mockClear();
		const stubHost = {
			get: vi.fn(),
			names: vi.fn(() => ["child-existing"]),
			ensure: vi.fn(),
			stopService: vi.fn(),
		};

		createAgentAdapter({ cwd: "/tmp", replyEvent: "llm.response", serviceHost: stubHost });

		expect(createFoundryRuntimeMock).not.toHaveBeenCalled();
	});

	it("falls back to a private Foundry runtime when no serviceHost is injected", () => {
		createFoundryRuntimeMock.mockClear();

		createAgentAdapter({ cwd: "/tmp", replyEvent: "llm.response" });

		expect(createFoundryRuntimeMock).toHaveBeenCalledTimes(1);
	});
});

describe("tools/agent's Foundry service wires the platform's own supervisor through", { tags: ["unit"] }, () => {
	it("passes the enriched Supervisor (opts.supervisor) as the adapter's serviceHost", async () => {
		createFoundryRuntimeMock.mockClear();

		// Supervisor.startService()/getOrStart() always enrich ServiceCreateOpts
		// with { supervisor: this } before calling descriptor.create(opts) —
		// reproduced here without a real Supervisor instance.
		const fakeSupervisor = {
			register: vi.fn(),
			getOrStart: vi.fn(),
			stop: vi.fn(),
			get: vi.fn(),
			adapters: vi.fn(() => []),
			tools: vi.fn(() => []),
			names: vi.fn(() => []),
		};

		await service.create({ cwd: "/tmp", supervisor: fakeSupervisor });

		expect(createFoundryRuntimeMock).not.toHaveBeenCalled();
	});
});
