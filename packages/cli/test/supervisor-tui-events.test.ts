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
import { createInMemoryStorage } from "@dpopsuev/alef-testkit";
import pino from "pino";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import "@dpopsuev/alef-coding-agent";

import type { AgentEvent } from "@dpopsuev/alef-session/contracts";
import { JsonlSessionStore } from "@dpopsuev/alef-session/store";
import { parseArgs } from "../src/boot/args.js";
import { assembleSession } from "../src/boot/assemble-session.js";
import { HeadlessViewMode } from "../src/boot/views.js";

const SILENT_LOGGER = pino({ level: "silent" });
const FAUX_PROVIDER = registerFauxProvider({ models: [{ id: "tui-event-test" }] });

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

describe("TUI event flow through Session mediator", { tags: ["unit"] }, () => {
	const tmpDirs: string[] = [];

	beforeEach(() => {
		FAUX_PROVIDER.setResponses([
			fauxAssistantMessage("event-test-reply"),
			fauxAssistantMessage("event-test-reply"),
			fauxAssistantMessage("event-test-reply"),
		]);
	});

	afterAll(() => {
		FAUX_PROVIDER.unregister();
	});

	afterEach(() => {
		for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	function makeTmp(): string {
		const d = mkdtempSync(join(tmpdir(), "alef-tui-events-"));
		tmpDirs.push(d);
		return d;
	}

	async function bootWithSession() {
		const faux = FAUX_PROVIDER;

		const cwd = makeTmp();
		const store = await JsonlSessionStore.create(cwd);
		const args = { ...parseArgs([]), cwd, noTui: true };
		const model = faux.getModel();

		const assembled = await assembleSession({
			args,
			cfg: {},
			log: SILENT_LOGGER,
			store,
			loaded: EMPTY_LOADED,
			model,
			storage: STUB_STORAGE,
		});
		return { assembled, faux, store };
	}

	it("session.subscribe receives LLM response events after send", async () => {
		const { assembled } = await bootWithSession();
		const session = assembled.session;

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
		const { assembled } = await bootWithSession();

		const viewer = new HeadlessViewMode();
		const running = viewer.run(assembled.session);

		const reply = await viewer.send("test message", 10_000);
		expect(reply).toContain("event-test-reply");

		expect(viewer.chunks().length).toBeGreaterThan(0);
		expect(viewer.replies()).toContain("event-test-reply");

		viewer.complete();
		await running;
	}, 15_000);

	it("session mediator exposes humanAddress and agentAddress", async () => {
		const { assembled } = await bootWithSession();

		expect(typeof assembled.humanAddress).toBe("string");
		expect(typeof assembled.agentAddress).toBe("string");
		expect(assembled.humanAddress.length).toBeGreaterThan(0);
		expect(assembled.agentAddress.length).toBeGreaterThan(0);
	}, 15_000);
});
