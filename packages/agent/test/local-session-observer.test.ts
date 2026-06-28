/**
 * Integration: createLocalSession → session.subscribe → AgentEvent delivery.
 *
 * The gap this covers: session.subscribe (the TUI path) must receive the same
 * AgentEvents dispatched by the signal observer inside createLocalSession.
 * Previously, SessionHandle._observers was populated by handle.subscribe but
 * never iterated — chunk events never reached the TUI.
 *
 * Given/When/Then:
 *   Given a local session backed by a faux LLM that streams a reply
 *   When HeadlessViewMode.run(session) is called and a message is sent
 *   Then viewer.chunks() is non-empty and viewer.lastReply() matches the reply
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@dpopsuev/alef-ai/faux";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

// Side-effect: registers the coding-agent blueprint in blueprintRegistry.
import "@dpopsuev/alef-coding-agent";

import { JsonlSessionStore } from "@dpopsuev/alef-session/store";
import type { StorageFactory } from "@dpopsuev/alef-storage";
import { parseArgs } from "../src/args.js";
import { buildIdentityContext, createLocalSession } from "../src/cli/local-session.js";
import { HeadlessViewMode } from "../src/view-mode.js";

const SILENT_LOGGER = pino({ level: "silent" });

const STUB_STORAGE: StorageFactory = {
	daemonRegistry: () => ({}) as never,
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

describe("createLocalSession — session.subscribe delivers AgentEvents to callers", { tags: ["unit"] }, () => {
	const tmpDirs: string[] = [];
	afterEach(() => {
		for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	function makeTmp(): string {
		const d = mkdtempSync(join(tmpdir(), "alef-session-obs-"));
		tmpDirs.push(d);
		return d;
	}

	it("chunk events from the faux LLM reach a session.subscribe observer", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("hello from local session")]);

		const cwd = makeTmp();
		const store = await JsonlSessionStore.create(cwd);
		const args = { ...parseArgs([]), cwd, noTui: true };
		const model = faux.getModel();

		const { session } = await createLocalSession(
			args,
			{},
			SILENT_LOGGER,
			store,
			EMPTY_LOADED,
			model,
			STUB_STORAGE,
			buildIdentityContext(store),
		);

		const viewer = new HeadlessViewMode();
		const running = viewer.run(session);
		await viewer.send("hi");
		viewer.complete();
		await running;

		expect(viewer.chunks().join("")).toContain("hello from local session");
		expect(viewer.lastReply()).toBe("hello from local session");

		session.dispose();
	}, 15_000);
});
