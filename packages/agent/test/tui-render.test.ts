/**
 * TUI render pipeline E2E test with MockTerminal.
 *
 * Tests the ACTUAL render path: session events → TUI dispatch →
 * requestRender() → doRender() → terminal.write(). Uses MockTerminal
 * instead of a real TTY.
 *
 * This catches bugs where the event flow works (HeadlessViewMode passes)
 * but the TUI renderer fails to paint (user sees "thinking" then nothing).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@dpopsuev/alef-ai/faux";
import type { StorageFactory } from "@dpopsuev/alef-storage";
import { MockTerminal } from "@dpopsuev/alef-tui/mock-terminal";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import "@dpopsuev/alef-coding-agent";

import { parseArgs } from "../src/args.js";
import { buildIdentityContext, createLocalSession } from "../src/cli/local-session.js";
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

		const { runTuiMode } = await import("../src/cli/tui-mode.js");
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

		// Wait for initial render
		await new Promise((r) => setTimeout(r, 200));

		// The TUI should have written SOMETHING to the terminal.
		// If this fails, doRender() never fired or produced empty output.
		// Debug: check terminal.output for any data at all
		if (terminal.output.length === 0) {
			// doRender never called terminal.write — the render pipeline is broken
			console.log("BUG CAUGHT: terminal.output is empty after 200ms");
			console.log("terminal.started:", terminal.started);
		}
		expect(terminal.output.length).toBeGreaterThan(0);

		// Send a message
		if (session.send) {
			await session.send("hello", 10_000);
		}

		// Wait for render cycle to process the response
		await new Promise((r) => setTimeout(r, 200));

		// The terminal should contain the response text
		const rendered = terminal.stripAnsi();
		expect(rendered).toContain("mock terminal reply");

		// Clean up
		session.dispose();
		await Promise.race([tuiDone, new Promise((r) => setTimeout(r, 500))]);
	}, 15_000);

	it("renders initial frame on boot without keypress", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("boot test")]);

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

		const { runTuiMode } = await import("../src/cli/tui-mode.js");
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

		// Wait for initial render — NO keypress
		await new Promise((r) => setTimeout(r, 100));

		// Terminal should have received render output without any input
		expect(terminal.output.length).toBeGreaterThan(0);
		expect(terminal.started).toBe(true);

		session.dispose();
		await Promise.race([tuiDone, new Promise((r) => setTimeout(r, 500))]);
	}, 15_000);
});
