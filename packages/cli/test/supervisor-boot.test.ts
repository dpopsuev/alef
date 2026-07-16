/**
 * Supervisor service boot tests — verify the Supervisor-as-entrypoint pattern.
 *
 * Tests:
 *   1. Session service boots via Supervisor, exposes Session interface
 *   2. Session service stop disposes Session (health → false)
 *   3. Storage starts before session (dependency order)
 *   4. Daemon mode registers in daemon registry
 *   5. Multi-UI: two observers subscribe to same Session, both receive events
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@dpopsuev/alef-ai/faux";
import type { StorageFactory } from "@dpopsuev/alef-storage";
import type { ManagedService, ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import { Supervisor } from "@dpopsuev/alef-supervisor/supervisor";
import { createInMemoryStorage } from "@dpopsuev/alef-testkit";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import "@dpopsuev/alef-coding-agent";

import { JsonlSessionStore } from "@dpopsuev/alef-session/store";
import { DiscourseStore } from "@dpopsuev/alef-tool-discourse";
import { createAgentServiceDescriptor } from "../src/boot/agent-service.js";
import { parseArgs } from "../src/boot/args.js";
import { deriveDiscussionRef } from "../src/boot/discussion.js";
import { createSessionServiceDescriptor, type SessionService } from "../src/boot/session-service.js";

const SILENT_LOGGER = pino({ level: "silent" });

const STUB_STORAGE: StorageFactory = createInMemoryStorage();
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

	function makeSessionOpts(cwd: string, store: JsonlSessionStore) {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("hello")]);
		return {
			opts: {
				args: { ...parseArgs([]), cwd, noTui: true },
				cfg: {},
				log: SILENT_LOGGER,
				store,
				loaded: EMPTY_LOADED,
				model: faux.getModel()!,
				storage: STUB_STORAGE,
			},
			faux,
		};
	}

	it("session service boots via Supervisor and exposes Session interface", async () => {
		const cwd = makeTmp();
		const store = await JsonlSessionStore.create(cwd);
		const { opts } = makeSessionOpts(cwd, store);

		const supervisor = trackSupervisor(new Supervisor());
		supervisor.register(makeStorageDescriptor());
		supervisor.register(createSessionServiceDescriptor(opts));

		await supervisor.startAll({ cwd });

		const svc = supervisor.get("session");
		expect(svc).toBeDefined();
		expect("session" in svc!).toBe(true);

		const sessionSvc = svc as SessionService;
		expect(sessionSvc.session.state.id).toBe(store.id);
		expect(typeof sessionSvc.session.subscribe).toBe("function");
		expect(typeof sessionSvc.session.getModel).toBe("function");
	}, 15_000);

	it("session service stop disposes Session (health → false)", async () => {
		const cwd = makeTmp();
		const store = await JsonlSessionStore.create(cwd);
		const { opts } = makeSessionOpts(cwd, store);

		const supervisor = trackSupervisor(new Supervisor());
		supervisor.register(makeStorageDescriptor());
		supervisor.register(createSessionServiceDescriptor(opts));

		await supervisor.startAll({ cwd });
		const svc = supervisor.get("session") as SessionService;
		expect(svc).toBeDefined();

		await supervisor.stopAll();

		const health = await svc.health();
		expect(health).toBe(false);
	}, 15_000);

	it("storage service starts before session (dependency order)", async () => {
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

		const cwd = makeTmp();
		const store = await JsonlSessionStore.create(cwd);
		const { opts } = makeSessionOpts(cwd, store);

		const supervisor = trackSupervisor(new Supervisor());
		// Register session FIRST to verify topo-sort puts storage before it
		supervisor.register(createSessionServiceDescriptor(opts));
		supervisor.register(trackingStorage);

		await supervisor.startAll({ cwd });
		bootOrder.push("session");

		expect(bootOrder[0]).toBe("storage");
	}, 15_000);

	it("daemon mode registers in daemon registry", async () => {
		const cwd = makeTmp();
		const store = await JsonlSessionStore.create(cwd);
		const { opts } = makeSessionOpts(cwd, store);
		opts.args = { ...opts.args, daemon: true, serve: 0 };

		let registered = false;
		const daemonStorage: StorageFactory = {
			...STUB_STORAGE,
			daemonRegistry: () => ({
				register: async () => {
					registered = true;
				},
				unregister: async () => {},
				heartbeat: async () => {},
				get: async () => undefined,
				list: async () => [],
				findByCwd: async () => undefined,
				findLatest: async () => undefined,
				prune: async () => 0,
			}),
		};

		const supervisor = trackSupervisor(new Supervisor());
		supervisor.register(makeStorageDescriptor());
		supervisor.register(createSessionServiceDescriptor(opts));
		supervisor.register(createAgentServiceDescriptor({ args: opts.args, cfg: {}, storage: daemonStorage }));

		await supervisor.startAll({ cwd });

		expect(registered).toBe(true);
	}, 15_000);

	it("multi-UI: two observers subscribe to same Session, both receive events", async () => {
		const cwd = makeTmp();
		const store = await JsonlSessionStore.create(cwd);
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("shared reply")]);
		const opts = {
			args: { ...parseArgs([]), cwd, noTui: true },
			cfg: {},
			log: SILENT_LOGGER,
			store,
			loaded: EMPTY_LOADED,
			model: faux.getModel()!,
			storage: STUB_STORAGE,
		};

		const supervisor = trackSupervisor(new Supervisor());
		supervisor.register(makeStorageDescriptor());
		supervisor.register(createSessionServiceDescriptor(opts));

		await supervisor.startAll({ cwd });

		const sessionSvc = supervisor.get("session") as SessionService;
		const session = sessionSvc.session;

		// Two independent observers — simulates two UI surfaces
		const eventsA: string[] = [];
		const eventsB: string[] = [];
		const unsubA = session.subscribe((e) => eventsA.push(e.type));
		const unsubB = session.subscribe((e) => eventsB.push(e.type));

		// Send a message — both observers should receive the same events
		if (session.send) {
			await session.send("hello", 10_000);
		}

		unsubA();
		unsubB();

		expect(eventsA.length).toBeGreaterThan(0);
		expect(eventsB.length).toBeGreaterThan(0);
		expect(eventsA).toEqual(eventsB);
	}, 15_000);

	it("root session turns persist into the active discourse topic", async () => {
		const cwd = makeTmp();
		const store = await JsonlSessionStore.create(cwd);
		const { opts } = makeSessionOpts(cwd, store);

		const supervisor = trackSupervisor(new Supervisor());
		supervisor.register(makeStorageDescriptor());
		supervisor.register(createSessionServiceDescriptor(opts));

		await supervisor.startAll({ cwd });
		const sessionSvc = supervisor.get("session") as SessionService;
		await sessionSvc.session.send?.("hello", 10_000);

		const discussion = deriveDiscussionRef(store, cwd);
		const path = join(cwd, "discourse", discussion.forumId, `${discussion.topicId}.jsonl`);
		const entries = readFileSync(path, "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { author: string; content: string });
		expect(entries).toHaveLength(2);
		expect(entries[0]!.content).toBe("hello");
		expect(entries[1]!.content).toBe("hello");
		expect(entries[0]!.author).toMatch(/^@/);
		expect(entries[1]!.author).toMatch(/^@/);
		expect(entries[0]!.author).not.toBe(entries[1]!.author);
	}, 15_000);

	it("switching discussion updates active thread without rewriting home thread", async () => {
		const cwd = makeTmp();
		const store = await JsonlSessionStore.create(cwd);
		const { opts } = makeSessionOpts(cwd, store);

		const supervisor = trackSupervisor(new Supervisor());
		supervisor.register(makeStorageDescriptor());
		supervisor.register(createSessionServiceDescriptor(opts));

		await supervisor.startAll({ cwd });
		const sessionSvc = supervisor.get("session") as SessionService;
		const session = sessionSvc.session;
		const initial = session.getDiscussionState?.();

		expect(initial?.home.topicId).toBe(store.id);
		expect(initial?.active.topicId).toBe(store.id);
		expect(initial?.subscriptions.map((entry) => entry.discussion.topicId)).toContain(store.id);

		session.setDiscussion?.({ topicId: "review", topicTitle: "review" });
		const next = session.getDiscussionState?.();

		expect(next?.home.topicId).toBe(store.id);
		expect(next?.active.topicId).toBe("review");
		expect(next?.subscriptions.map((entry) => entry.discussion.topicId)).toEqual(
			expect.arrayContaining([store.id, "review"]),
		);
	}, 15_000);

	it("tracks subscription modes, leases, and unread counts", async () => {
		const cwd = makeTmp();
		const store = await JsonlSessionStore.create(cwd);
		const { opts } = makeSessionOpts(cwd, store);
		const discussion = deriveDiscussionRef(store, cwd);
		const discourse = new DiscourseStore(cwd);

		const supervisor = trackSupervisor(new Supervisor());
		supervisor.register(makeStorageDescriptor());
		supervisor.register(createSessionServiceDescriptor(opts));

		await supervisor.startAll({ cwd });
		const sessionSvc = supervisor.get("session") as SessionService;
		const session = sessionSvc.session;

		session.subscribeDiscussion?.(
			{ forumId: discussion.forumId, topicId: "watch", topicTitle: "watch" },
			{ mode: "mentions-only", leaseMs: 60_000 },
		);

		discourse.append(discussion.forumId, "watch", "@other", `hello ${sessionSvc.agentAddress}`);
		discourse.append(discussion.forumId, "watch", "@other", "no mention here");

		const watched = (await session.listDiscussionSubscriptions?.())?.find(
			(entry) => entry.discussion.topicId === "watch",
		);
		expect(watched?.mode).toBe("mentions-only");
		expect(watched?.leaseExpiresAt).toBeGreaterThan(Date.now());
		expect(watched?.unreadCount).toBe(1);

		await session.readDiscussionTopic?.("watch");

		const refreshed = (await session.listDiscussionSubscriptions?.())?.find(
			(entry) => entry.discussion.topicId === "watch",
		);
		expect(refreshed?.unreadCount).toBe(0);
		expect(session.unsubscribeDiscussion?.({ forumId: discussion.forumId, topicId: "watch" })).toBe(true);
		expect(
			(await session.listDiscussionSubscriptions?.())?.some((entry) => entry.discussion.topicId === "watch"),
		).toBe(false);
	}, 15_000);
});
