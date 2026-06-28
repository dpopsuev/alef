/**
 * Supervisor full lifecycle E2E test — boot → interact → exit.
 *
 * Catches a real bug: createTuiServiceDescriptor fires viewer.run()
 * as fire-and-forget with no completion signal. The entrypoint has
 * no way to detect the viewer finished, so it blocks on
 * `await new Promise(() => {})` forever.
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

import { JsonlSessionStore } from "@dpopsuev/alef-session/store";
import { parseArgs } from "../src/boot/args.js";
import { createSessionServiceDescriptor } from "../src/session/session-service.js";
import { createTuiServiceDescriptor } from "../src/session/tui-service.js";

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

describe("Supervisor full lifecycle", { tags: ["unit"] }, () => {
	const tmpDirs: string[] = [];
	const supervisors: Supervisor[] = [];

	afterEach(async () => {
		for (const s of supervisors.splice(0)) await s.stopAll().catch(() => {});
		for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	function makeTmp(): string {
		const d = mkdtempSync(join(tmpdir(), "alef-lifecycle-"));
		tmpDirs.push(d);
		return d;
	}

	it("TUI service exposes done promise that resolves when viewer exits", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("lifecycle test")]);

		const cwd = makeTmp();
		const store = await JsonlSessionStore.create(cwd);
		const args = { ...parseArgs(["-p", "hello"]), cwd };
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
		supervisor.register(createTuiServiceDescriptor({ args, store }));

		await supervisor.startAll({ cwd });

		const tuiSvc = supervisor.get("tui");
		expect(tuiSvc).toBeDefined();

		// THE BUG: the TUI service has no `done` promise.
		// The entrypoint needs to know when the viewer finishes so it can exit.
		// This assertion catches the missing API:
		expect("done" in tuiSvc!).toBe(true);

		// Wait for done to resolve (viewer should complete since json mode
		// reads stdin which is empty in tests)
		const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5_000));
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test: checking the done field exists
		const donePromise = (tuiSvc as ManagedService & { done: Promise<void> }).done;
		const result = await Promise.race([donePromise.then(() => "done" as const), timeout]);
		expect(result).toBe("done");
	}, 15_000);
});
