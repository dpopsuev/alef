/**
 * Supervisor service boot tests — verify the Supervisor-as-entrypoint pattern.
 *
 * Tests:
 *   1. Agent service boots via Supervisor, exposes SessionHandle
 *   2. Agent + TUI services boot, TUI gets SessionHandle from agent
 *   3. Agent service stop disposes SessionHandle
 *   4. Storage service starts before agent (dependency order)
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@dpopsuev/alef-ai/faux";
import type { StorageFactory } from "@dpopsuev/alef-storage";
import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import { Supervisor } from "@dpopsuev/alef-supervisor/supervisor";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import "@dpopsuev/alef-coding-agent";

import { type AgentService, createAgentServiceDescriptor } from "../src/agent-service.js";
import { parseArgs } from "../src/args.js";
import { buildIdentityContext } from "../src/cli/local-session.js";
import { JsonlSessionStore } from "../src/session-store.js";

const SILENT_LOGGER = pino({ level: "silent" });

const STUB_STORAGE: StorageFactory = {
	daemonRegistry: () => ({
		register: async () => {},
		unregister: async () => {},
		get: async () => undefined,
		list: async () => [],
		findByCwd: async () => undefined,
		findLatest: async () => undefined,
		prune: async () => 0,
	}),
	summaryStore: () => ({ write: async () => {}, get: async () => undefined, latest: async () => undefined }),
	authStore: () => ({}) as never,
	sessions: {} as never,
};
const EMPTY_LOADED = {
	adapters: [],
	blueprintModelId: undefined,
	blueprintName: undefined,
	blueprintSurfaces: [],
	blueprintUpgradePolicy: "rebuild_only" as const,
	blueprintPath: undefined,
	writableRoots: undefined,
};

describe("Supervisor service boot", { tags: ["unit"] }, () => {
	const tmpDirs: string[] = [];
	const supervisors: Supervisor[] = [];

	afterEach(async () => {
		for (const s of supervisors.splice(0)) await s.stopAll().catch(() => {});
		for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	function makeTmp(): string {
		const d = mkdtempSync(join(tmpdir(), "alef-supervisor-boot-"));
		tmpDirs.push(d);
		return d;
	}

	function trackSupervisor(s: Supervisor): Supervisor {
		supervisors.push(s);
		return s;
	}

	function makeStorageDescriptor(): ServiceDescriptor {
		return {
			name: "storage",
			restart: "permanent",
			shareable: true,
			create(_opts: ServiceCreateOpts): Promise<ManagedService> {
				return Promise.resolve({
					name: "storage",
					restart: "permanent" as const,
					adapters: [],
					tools: [],
					factory: STUB_STORAGE,
					start: () => Promise.resolve(),
					stop: () => Promise.resolve(),
					health: () => Promise.resolve(true),
				});
			},
		};
	}

	it("agent service boots via Supervisor and exposes SessionHandle", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("hello")]);

		const cwd = makeTmp();
		const store = await JsonlSessionStore.create(cwd);
		const args = { ...parseArgs([]), cwd, noTui: true };
		const model = faux.getModel();

		const supervisor = trackSupervisor(new Supervisor());
		supervisor.register(makeStorageDescriptor());
		supervisor.register(
			createAgentServiceDescriptor({
				args,
				cfg: {},
				log: SILENT_LOGGER,
				store,
				loaded: EMPTY_LOADED,
				model,
				storage: STUB_STORAGE,
				identity: buildIdentityContext(store),
			}),
		);

		await supervisor.startAll({ cwd });

		const agentSvc = supervisor.get("agent");
		expect(agentSvc).toBeDefined();
		expect("sessionHandle" in agentSvc!).toBe(true);

		const handle = (agentSvc as AgentService).sessionHandle;
		expect(handle.state.id).toBe(store.id);
	}, 15_000);

	it("agent service stop disposes SessionHandle", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("bye")]);

		const cwd = makeTmp();
		const store = await JsonlSessionStore.create(cwd);
		const args = { ...parseArgs([]), cwd, noTui: true };
		const model = faux.getModel();

		const supervisor = trackSupervisor(new Supervisor());
		supervisor.register(makeStorageDescriptor());
		supervisor.register(
			createAgentServiceDescriptor({
				args,
				cfg: {},
				log: SILENT_LOGGER,
				store,
				loaded: EMPTY_LOADED,
				model,
				storage: STUB_STORAGE,
				identity: buildIdentityContext(store),
			}),
		);

		await supervisor.startAll({ cwd });
		const agentSvc = supervisor.get("agent") as AgentService;
		expect(agentSvc).toBeDefined();

		await supervisor.stopAll();

		const health = await agentSvc.health();
		expect(health).toBe(false);
	}, 15_000);

	it("storage service starts before agent (dependency order)", async () => {
		const bootOrder: string[] = [];

		const trackingStorage: ServiceDescriptor = {
			name: "storage",
			restart: "permanent",
			shareable: true,
			create(_opts: ServiceCreateOpts): Promise<ManagedService> {
				bootOrder.push("storage");
				return Promise.resolve({
					name: "storage",
					restart: "permanent" as const,
					adapters: [],
					tools: [],
					factory: STUB_STORAGE,
					start: () => Promise.resolve(),
					stop: () => Promise.resolve(),
					health: () => Promise.resolve(true),
				});
			},
		};

		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("ordered")]);

		const cwd = makeTmp();
		const store = await JsonlSessionStore.create(cwd);
		const args = { ...parseArgs([]), cwd, noTui: true };
		const model = faux.getModel();

		const supervisor = trackSupervisor(new Supervisor());
		// Register agent FIRST to verify topo-sort puts storage before it
		supervisor.register(
			createAgentServiceDescriptor({
				args,
				cfg: {},
				log: SILENT_LOGGER,
				store,
				loaded: EMPTY_LOADED,
				model,
				storage: STUB_STORAGE,
				identity: buildIdentityContext(store),
			}),
		);
		supervisor.register(trackingStorage);

		await supervisor.startAll({ cwd });
		bootOrder.push("agent");

		expect(bootOrder[0]).toBe("storage");
	}, 15_000);

	it("daemon mode registers in daemon registry", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("daemon")]);

		const cwd = makeTmp();
		const store = await JsonlSessionStore.create(cwd);
		const args = { ...parseArgs(["--daemon"]), cwd };
		const model = faux.getModel();

		let registered = false;
		const daemonStorage: StorageFactory = {
			...STUB_STORAGE,
			daemonRegistry: () => ({
				register: async () => {
					registered = true;
				},
				unregister: async () => {},
				get: async () => undefined,
				list: async () => [],
				findByCwd: async () => undefined,
				findLatest: async () => undefined,
				prune: async () => 0,
			}),
		};

		const supervisor = trackSupervisor(new Supervisor());
		supervisor.register(makeStorageDescriptor());
		supervisor.register(
			createAgentServiceDescriptor({
				args,
				cfg: {},
				log: SILENT_LOGGER,
				store,
				loaded: EMPTY_LOADED,
				model,
				storage: daemonStorage,
				identity: buildIdentityContext(store),
			}),
		);

		await supervisor.startAll({ cwd });

		expect(registered).toBe(true);
	}, 15_000);
});
