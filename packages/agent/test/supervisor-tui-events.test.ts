/**
 * TUI event flow tests — verify events propagate through the Session mediator.
 *
 * Tests:
 *   1. TUI service receives LLM response events via session.subscribe
 *   2. TUI submit → session.send → LLM reply round-trip
 *   3. actorRoutes available in interactive options
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

import type { AgentEvent } from "@dpopsuev/alef-session/contracts";
import { JsonlSessionStore } from "@dpopsuev/alef-session/store";
import { parseArgs } from "../src/boot/args.js";
import { HeadlessViewMode } from "../src/cli/view-mode.js";
import { createSessionServiceDescriptor, type SessionService } from "../src/session/session-service.js";

const SILENT_LOGGER = pino({ level: "silent" });

const STUB_STORAGE: StorageFactory = {
	daemonRegistry: () => ({
		register: async () => {},
		unregister: async () => {},
		heartbeat: async () => {},
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

describe("TUI event flow through Session mediator", { tags: ["unit"] }, () => {
	const tmpDirs: string[] = [];
	const supervisors: Supervisor[] = [];

	afterEach(async () => {
		for (const s of supervisors.splice(0)) await s.stopAll().catch(() => {});
		for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	function makeTmp(): string {
		const d = mkdtempSync(join(tmpdir(), "alef-tui-events-"));
		tmpDirs.push(d);
		return d;
	}

	async function bootWithSession() {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("event-test-reply")]);

		const cwd = makeTmp();
		const store = await JsonlSessionStore.create(cwd);
		const args = { ...parseArgs([]), cwd, noTui: true };
		const model = faux.getModel();

		const supervisor = new Supervisor();
		supervisors.push(supervisor);
		supervisor.register(makeStorageDescriptor());
		supervisor.register(
			createSessionServiceDescriptor({
				args,
				cfg: {},
				log: SILENT_LOGGER,
				store,
				loaded: EMPTY_LOADED,
				model,
				storage: STUB_STORAGE,
			}),
		);

		await supervisor.startAll({ cwd });
		const sessionSvc = supervisor.get("session") as SessionService;
		return { supervisor, sessionSvc, faux, store };
	}

	it("session.subscribe receives LLM response events after send", async () => {
		const { sessionSvc } = await bootWithSession();
		const session = sessionSvc.session;

		const events: AgentEvent[] = [];
		session.subscribe((e) => events.push(e));

		if (session.send) {
			await session.send("hello", 10_000);
		}

		const types = events.map((e) => e.type);
		expect(types).toContain("chunk");
		expect(types).toContain("turn-complete");
	}, 15_000);

	it("HeadlessViewMode receives events through session mediator", async () => {
		const { sessionSvc } = await bootWithSession();

		const viewer = new HeadlessViewMode();
		const running = viewer.run(sessionSvc.session);

		const reply = await viewer.send("test message", 10_000);
		expect(reply).toContain("event-test-reply");

		expect(viewer.chunks().length).toBeGreaterThan(0);
		expect(viewer.replies()).toContain("event-test-reply");

		viewer.complete();
		await running;
	}, 15_000);

	it("session mediator exposes humanAddress and agentAddress", async () => {
		const { sessionSvc } = await bootWithSession();

		expect(typeof sessionSvc.humanAddress).toBe("string");
		expect(typeof sessionSvc.agentAddress).toBe("string");
		expect(sessionSvc.humanAddress.length).toBeGreaterThan(0);
		expect(sessionSvc.agentAddress.length).toBeGreaterThan(0);
	}, 15_000);
});
