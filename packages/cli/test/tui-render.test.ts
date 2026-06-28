/**
 * TUI render pipeline E2E test with MockTerminal.
 *
 * Tests the ACTUAL render path: session events → TUI dispatch →
 * requestRender() → doRender() → terminal.write().
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@dpopsuev/alef-ai/faux";
import type { StorageFactory } from "@dpopsuev/alef-storage";
import { TUI } from "@dpopsuev/alef-tui";
import { MockTerminal } from "@dpopsuev/alef-tui/mock-terminal";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import "@dpopsuev/alef-coding-agent";

import { JsonlSessionStore } from "@dpopsuev/alef-session/store";
import { parseArgs } from "../src/boot/args.js";
import { buildIdentityContext, createLocalSession } from "../src/client/local-session.js";

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

describe("TUI render pipeline with MockTerminal", { tags: ["unit"] }, () => {
	const tmpDirs: string[] = [];

	afterEach(() => {
		for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	function makeTmp(): string {
		const d = mkdtempSync(join(tmpdir(), "alef-tui-render-"));
		tmpDirs.push(d);
		return d;
	}

	it("TUI.requestRender writes to MockTerminal (isolated)", async () => {
		const terminal = new MockTerminal(80, 24);
		const tui = new TUI(terminal);

		tui.start();
		tui.requestRender();

		// Wait for process.nextTick → scheduleRender → setTimeout(doRender)
		await new Promise((r) => setTimeout(r, 100));

		// TUI should have rendered SOMETHING (even an empty frame writes cursor positioning)
		expect(terminal.output.length).toBeGreaterThan(0);

		tui.stop();
	});

	it("TUI.requestRender works inside an async function (like runTuiMode)", async () => {
		const terminal = new MockTerminal(80, 24);
		const tui = new TUI(terminal);

		// Simulate what runTuiMode does: async setup, then start + requestRender
		await new Promise((r) => setTimeout(r, 10)); // simulate async buildLayout

		tui.start();
		tui.requestRender();

		// Wait for render
		await new Promise((r) => setTimeout(r, 100));

		expect(terminal.output.length).toBeGreaterThan(0);

		tui.stop();
	});

	it("renders LLM response text to terminal after message round-trip", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("mock terminal reply")]);

		const cwd = makeTmp();
		const store = await JsonlSessionStore.create(cwd);
		const args = { ...parseArgs([]), cwd, noTui: false };
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

		const terminal = new MockTerminal(120, 40);

		const { runTuiMode } = await import("../src/client/tui-mode.js");
		const tuiDone = runTuiMode(session, {
			cwd: args.cwd,
			modelId: "faux/test",
			sessionId: store.id,
			contextWindow: model.contextWindow,
			getModel: () => model.id,
			setModel: () => {},
			getThinking: () => "off",
			setThinking: () => {},
			terminal,
		});

		// Wait for buildLayout + splash render + initial render
		// buildLayout is async (font rasterization), may take >200ms
		for (let i = 0; i < 20; i++) {
			await new Promise((r) => setTimeout(r, 100));
			if (terminal.output.length > 0) break;
		}

		if (terminal.output.length > 0) {
			if (session.send) {
				await session.send("hello", 10_000);
			}

			for (let i = 0; i < 20; i++) {
				await new Promise((r) => setTimeout(r, 100));
				if (terminal.stripAnsi().includes("mock terminal reply")) break;
			}

			expect(terminal.stripAnsi()).toContain("mock terminal reply");
		} else {
			// Initial render didn't fire — this IS the bug
			expect.fail("BUG: terminal.output is empty after runTuiMode + 200ms — doRender never wrote to terminal");
		}

		session.dispose();
		await Promise.race([tuiDone, new Promise((r) => setTimeout(r, 500))]);
	}, 15_000);
});
